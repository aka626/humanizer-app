import Replicate from "replicate";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "../../../utils/supabase/server";

export const runtime = "nodejs";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const BUY_URL = "https://firsttakeaudio.com/buy";

function isOwner(email) {
  const list = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

function adminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) return null;
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
    },
  });
}

// Pull the object path out of a Supabase signed URL so we can delete it after.
// Signed URLs look like:
//   https://<proj>.supabase.co/storage/v1/object/sign/uploads/<filename>?token=...
function uploadPathFromUrl(url) {
  try {
    const u = new URL(url);
    const marker = "/uploads/";
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(u.pathname.slice(idx + marker.length));
  } catch {
    return null;
  }
}

async function deleteUpload(audioUrl) {
  try {
    const admin = adminClient();
    if (!admin) return;
    const path = uploadPathFromUrl(audioUrl);
    if (!path) return;
    await admin.storage.from("uploads").remove([path]);
  } catch (e) {
    console.error("Upload cleanup failed:", e);
  }
}

export async function POST(request) {
  let runId = null;
  let charged = false;
  let supabase = null;
  let userId = null;
  let audioUrl = null;
  try {
    const body = await request.json();
    audioUrl = body.audioUrl;
    if (!audioUrl) {
      return Response.json({ error: "No audio URL provided" }, { status: 400 });
    }

    // 1) Who is asking?
    supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const user = userData && userData.user;
    if (!user) {
      return Response.json(
        { error: "Please log in to humanize a track." },
        { status: 401 }
      );
    }
    userId = user.id;
    const owner = isOwner(user.email);

    let creditsLeft = null;

    // 2) Every separation costs 1 credit. Owners skip the charge.
    if (!owner) {
      const { data: creditRow } = await supabase
        .from("credits")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();
      const balance = creditRow ? creditRow.balance : 0;
      if (!balance || balance <= 0) {
        return Response.json(
          {
            error:
              "You're out of credits. A separation costs 1 credit. Grab some to keep going.",
            needCredits: true,
            buyUrl: BUY_URL,
          },
          { status: 402 }
        );
      }
      const { data: remaining, error: spendErr } = await supabase.rpc(
        "consume_credit"
      );
      if (spendErr) {
        return Response.json(
          { error: "Could not spend a credit. Try again." },
          { status: 500 }
        );
      }
      charged = true;
      creditsLeft = typeof remaining === "number" ? remaining : null;
    }

    // 3) Record the run, refund and remove on failure.
    const { data: runRow, error: insErr } = await supabase
      .from("humanizer_runs")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (insErr) {
      if (charged) await refund(userId);
      return Response.json(
        { error: "Could not start your run. Try again." },
        { status: 500 }
      );
    }
    runId = runRow.id;

    // 4) Do the separation.
    const output = await replicate.run(
      "ryan5453/demucs:5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77",
      {
        input: {
          audio: audioUrl,
          model: "htdemucs",
          stem: "vocals",
        },
      }
    );
    const stems = {};
    for (const key in output) {
      const val = output[key];
      stems[key] = typeof val === "string" ? val : val && val.url ? val.url() : String(val);
    }

    // 5) The source upload has done its job. Delete it so storage never
    //    accumulates. A failure here must not affect the user's result.
    await deleteUpload(audioUrl);

    return Response.json({ stems, creditsLeft });
  } catch (err) {
    console.error("Separation error:", err);
    if (runId && supabase) {
      try {
        await supabase.from("humanizer_runs").delete().eq("id", runId);
      } catch {}
    }
    if (charged) await refund(userId);
    // Clean up the upload even on failure, so a failed run leaves nothing behind.
    if (audioUrl) await deleteUpload(audioUrl);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function refund(userId) {
  try {
    const admin = adminClient();
    if (!admin || !userId) return;
    await admin.rpc("add_credits", { target_user: userId, amount: 1 });
  } catch (e) {
    console.error("Refund failed:", e);
  }
}
