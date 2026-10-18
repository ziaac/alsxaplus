import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to the content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  if (!isRouteErrorResponse(error)) console.error("[page] failed:", error);
  return (
    <main id="main" className="page">
      <h1>{status === 404 ? "We could not find that page" : "This page is not available right now"}</h1>
      <p>
        <Link className="button" to="/">
          Back to the start
        </Link>
      </p>
    </main>
  );
}
