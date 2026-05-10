export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">askrepo</h1>
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        Chat with any public GitHub repo. Bring your own free Gemini API
        key, paste a URL, ask questions, get streaming answers with
        citations back to specific files.
      </p>
      <p className="text-xs text-zinc-500">Work in progress.</p>
    </main>
  );
}
