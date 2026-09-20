import {
  createClient,
  Code,
  ConnectError,
  type Client,
} from "@connectrpc/connect";
import { DemoService, type Message } from "./gen/demo_pb.js";
import { openBridgeConnection, type BridgeConnection } from "./index.js";
import { inputQueue } from "./queue.js";
import { runChecks } from "./verify.js";

const el = (id: string) => document.getElementById(id)!;
const value = (id: string) => (el(id) as HTMLInputElement).value;
const button = (id: string) => el(id) as HTMLButtonElement;
function log(id: string, message: string) {
  const output = el(id);
  output.textContent = (output.textContent + "\n" + message)
    .split("\n")
    .slice(-100)
    .join("\n");
  output.scrollTop = output.scrollHeight;
}
let connection: BridgeConnection | undefined,
  client: Client<typeof DemoService> | undefined;
let counter: AbortController | undefined;
let chat:
  | ReturnType<
      typeof inputQueue<Partial<Omit<Message, "$typeName" | "$unknown">>>
    >
  | undefined;
function enabled(state: boolean) {
  document
    .querySelectorAll<HTMLButtonElement>("[data-rpc]")
    .forEach((b) => (b.disabled = !state));
  button("connect").disabled = state;
  button("disconnect").disabled = !state;
}
function action(id: string, output: string, run: () => Promise<void>) {
  button(id).onclick = () => {
    void run().catch((error) => log(output, String(error)));
  };
}
button("connect").onclick = async () => {
  button("connect").disabled = true;
  el("status").textContent = "Connecting…";
  try {
    connection = await openBridgeConnection({
      url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/tunnel`,
      target: value("target"),
      tunnelToken: value("token"),
      backendBearerToken: (el("forward-token") as HTMLInputElement).checked
        ? value("token")
        : undefined,
    });
    client = createClient(DemoService, connection.transport);
    enabled(true);
    el("status").textContent = "Connected · one HTTP/2 session";
    const current = connection;
    void current.closed.then(() => {
      if (connection === current) {
        enabled(false);
        el("status").textContent = "Disconnected · reconnect explicitly";
        client = undefined;
        chat = undefined;
        button("finish").disabled = true;
      }
    });
  } catch (error) {
    el("status").textContent = String(error);
    button("connect").disabled = false;
  }
};
button("disconnect").onclick = () => void connection?.close();
action("echo", "echo-output", async () => {
  const result = await client!.echo(
    { text: value("echo-input") },
    {
      onTrailer: (t) => log("echo-output", `trailer: ${t.get("demo-trailer")}`),
    },
  );
  log("echo-output", `← ${result.text}`);
});
action("count", "count-output", async () => {
  counter?.abort();
  const own = new AbortController();
  counter = own;
  button("cancel-count").disabled = false;
  try {
    for await (const result of client!.count(
      { number: 10, delayMs: 400 },
      { signal: own.signal },
    ))
      log("count-output", `← ${result.text}`);
    log("count-output", "grpc-status: OK");
  } finally {
    if (counter === own) {
      counter = undefined;
      button("cancel-count").disabled = true;
    }
  }
});
button("cancel-count").onclick = () => counter?.abort();
action("collect", "collect-output", async () => {
  const input = (async function* () {
    for (let number = 1; number <= 5; number++) {
      log("collect-output", `→ ${number}`);
      yield { number };
    }
  })();
  const result = await client!.collect(input);
  log("collect-output", `← sum ${result.number} (${result.text})`);
});
action("chat", "chat-output", async () => {
  if (!chat) {
    chat = inputQueue<Partial<Omit<Message, "$typeName" | "$unknown">>>();
    const own = chat;
    button("finish").disabled = false;
    void (async () => {
      try {
        for await (const result of client!.chat(own.messages))
          log("chat-output", `← ${result.text}`);
        log("chat-output", "grpc-status: OK · half-close complete");
      } catch (error) {
        log("chat-output", String(error));
      } finally {
        if (chat === own) {
          chat = undefined;
          button("finish").disabled = true;
        }
      }
    })();
  }
  const text = value("chat-input");
  await chat.send({ text });
  log("chat-output", `→ ${text}`);
});
action("finish", "chat-output", async () => {
  await chat?.complete();
  button("finish").disabled = true;
});
action("verify", "check-output", async () => {
  button("verify").disabled = true;
  el("check-output").textContent = "Running…";
  try {
    await runChecks(client!, (message) => log("check-output", message));
    log("check-output", "ALL CHECKS PASSED");
  } finally {
    button("verify").disabled = !client;
  }
});
