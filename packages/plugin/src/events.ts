export interface LensEventRecord {
  id: number;
  type: string;
  at: number;
  data: unknown;
}

export class EventHub {
  private nextID = 1;
  private readonly buffer: LensEventRecord[] = [];
  private readonly listeners = new Set<(event: LensEventRecord) => void>();

  constructor(private readonly capacity = 100) {}

  publish(type: string, data: unknown) {
    const event = { id: this.nextID++, type, at: Date.now(), data };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) listener(event);
  }

  stream(lastEventID?: number) {
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const event of this.replayAfter(lastEventID)) {
            controller.enqueue(encoder.encode(formatSse(event)));
          }

          const listener = (event: LensEventRecord) => controller.enqueue(encoder.encode(formatSse(event)));
          this.listeners.add(listener);

          const heartbeat = setInterval(() => {
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }, 15_000);

          return () => {
            clearInterval(heartbeat);
            this.listeners.delete(listener);
          };
        },
        cancel: () => undefined,
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  }

  private replayAfter(lastEventID: number | undefined) {
    if (!lastEventID) return [];
    return this.buffer.filter((event) => event.id > lastEventID);
  }
}

function formatSse(event: LensEventRecord) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
