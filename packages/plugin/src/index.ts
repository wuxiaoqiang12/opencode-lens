import { startLens } from "./runtime";

let runtime: Awaited<ReturnType<typeof startLens>> | undefined;

async function start(input: unknown) {
  if (runtime) return runtime;
  runtime = await startLens(input).catch((error) => {
    console.error("opencode-lens failed to initialize", error);
    return undefined;
  });
  return runtime;
}

export const OpencodeLensPlugin = async (input: unknown) => {
  const lens = await start(input);
  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (!lens) return;
      lens.events.publish(event.type, event.properties ?? {});
      const status = lens.state.handleEvent(event);
      if (status) lens.events.publish("session.state", status);
    },
  };
};

export const OpencodeLensTuiPlugin = {
  id: "opencode-lens",
  tui: OpencodeLensPlugin,
};

export default OpencodeLensTuiPlugin;
