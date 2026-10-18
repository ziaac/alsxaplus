import { Link } from "react-router";

/** The frame around the plain pages: a way home, a way to the simulation, and the same footer everywhere. */
export function Page({ current, children }: { current: string; children: React.ReactNode }) {
  return (
    <main id="main" className="page">
      <header className="site-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{current}</span>
        </nav>
        <nav aria-label="Pages" className="top-nav">
          <Link to="/sim">Simulation</Link>
          <Link to="/guide">How to use</Link>
        </nav>
      </header>
      {children}
      <footer className="site-foot">
        <Link to="/about">About</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </footer>
    </main>
  );
}
