import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sim", "routes/sim.tsx"),
  route("guide", "routes/guide.tsx"),
  route("about", "routes/about.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("terms", "routes/terms.tsx"),
  route("api/assistant", "routes/api.assistant.ts"),
  route("api/voice", "routes/api.voice.ts"),
] satisfies RouteConfig;
