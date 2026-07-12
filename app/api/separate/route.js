import Replicate from "replicate";
import { createClient } from "../../../utils/supabase/server";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// How many free separations each account gets. Change in Vercel env, no code edit.
const FREE_RUNS = parseInt(process.env.FREE_RUNS || "1", 10);

// Comma-separated list of emails that skip the limit (you, testers).
function isOwner(email) {
  const list = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

export async function POST(request) {
  let runId = null;
  let supabase = null;
  try {
    const { audioUrl } = await request.json();
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

    // 2) Enforce the free limit, unless this is an owner account.
    if (!isOwner(user.email)) {
      const { count, error: countErr } = await supabase
        .from("humanizer_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      if (countErr) {
        return Response.json(
          { error: "Could not check your usage. Try again." },
          { status: 500 }
        );
      }
      if ((count || 0) >= FREE_RUNS) {
        return Response.json(
          {
            error:
              "You have used your free separation. Paid plans are coming soon, and your ears already know it works.",
            limitReached: true,
          },
          { status: 403 }
        );
      }
    }

    // 3) Record the run BEFORE spending money, refund if it fails.
    const { data: runRow, error: insErr } = await supabase
      .from("humanizer_runs")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (insErr) {
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
    return Response.json({ stems });
  } catch (err) {
    console.error("Separation error:", err);
    // Refund: the run failed, so it should not count against the free limit.
    if (runId && supabase) {
      try {
        await supabase.from("humanizer_runs").delete().eq("id", runId);
      } catch {}
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
}
