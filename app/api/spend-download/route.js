import { createClient } from "../../../utils/supabase/server";

export const runtime = "nodejs";

const BUY_URL = "https://firsttakeaudio.com/buy";

function isOwner(email) {
  const list = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

export async function POST() {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const user = userData && userData.user;
    if (!user) {
      return Response.json({ ok: false, error: "Not logged in." }, { status: 401 });
    }

    if (isOwner(user.email)) {
      return Response.json({ ok: true, owner: true, remaining: null });
    }

    const { data: creditRow } = await supabase
      .from("credits")
      .select("balance")
      .eq("user_id", user.id)
      .maybeSingle();
    const balance = creditRow ? creditRow.balance : 0;
    if (!balance || balance <= 0) {
      return Response.json(
        {
          ok: false,
          error: "Downloading costs 1 credit and you're out. Grab a pack to keep your track.",
          needCredits: true,
          buyUrl: BUY_URL,
        },
        { status: 402 }
      );
    }

    const { data: remaining, error: spendErr } = await supabase.rpc("consume_credit");
    if (spendErr) {
      return Response.json(
        { ok: false, error: "Could not spend a credit. Try again." },
        { status: 500 }
      );
    }

    return Response.json({
      ok: true,
      remaining: typeof remaining === "number" ? remaining : null,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err.message || "Spend failed" },
      { status: 500 }
    );
  }
}
