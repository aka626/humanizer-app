import ExtractorClient from "./extractor-client";

export const metadata = {
  title: "First Take MIDI Extractor",
  description: "Keep the sound. Rewrite the notes. Pull your AI track's notes as MIDI, with its voice as a playable instrument.",
};

export default function Page() {
  return <ExtractorClient />;
}
