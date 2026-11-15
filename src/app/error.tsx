"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="page">
      <section className="banner" role="alert">
        <h2>The dashboard could not load its data</h2>
        <p>The database could not be read. No figures are shown rather than guessing any.</p>
        <button className="btn" type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
