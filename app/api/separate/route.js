import Replicate from "replicate";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

export async function POST(request) {
  try {
    const { audioUrl } = await request.json();
    if (!audioUrl) {
      return Response.json({ error: "No audio URL provided" }, { status: 400 });
    }

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
    return Response.json({ error: err.message }, { status: 500 });
  }
}
