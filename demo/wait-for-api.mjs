// Waits until the demo API server accepts connections, so Vite doesn't proxy an open tab's polls into ECONNREFUSED
// errors during the second or two the server takes to start. Gives up quietly after 60s and lets Vite start anyway.
import { connect } from "node:net";

const port = Number(process.env.DEMO_PORT ?? 8787);
const deadline = Date.now() + 60_000;
const attempt = () => {
  const s = connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); process.exit(0); });
  s.once("error", () => { s.destroy(); Date.now() > deadline ? process.exit(0) : setTimeout(attempt, 250); });
};
attempt();
