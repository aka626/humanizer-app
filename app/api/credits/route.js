import { createClient } from "../../../utils/supabase/server";

export const runtime = "nodejs";

const FREE_RUNS = parseInt(process.env.FREE_RUNS || "1", 10);

function isOwner(email) {
  const list = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const user = userData && userData.user;
    if (!user) {
      return Response.json({ ok: false, error: "Not logged in." }, { status: 401 });
    }

    const { data: creditRow } = await supabase
      .from("credits")
      .select("balance")
      .eq("user_id", user.id)
      .maybeSingle();

    const { count } = await supabase
      .from("humanizer_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    return Response.json({
      ok: true,
      balance: creditRow ? creditRow.balance : 0,
      isOwner: isOwner(user.email),
      freeRunsTotal: FREE_RUNS,
      freeRunsUsed: count || 0,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err.message || "Could not load credits" },
      { status: 500 }
    );
  }
}
