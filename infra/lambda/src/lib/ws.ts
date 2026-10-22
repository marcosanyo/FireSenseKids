import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { apiGatewayPusher } from "./push";
import type { Ctx } from "./relay-core";
import { DynamoStore } from "./store";

let store: DynamoStore | null = null;

export function wsContext(event: APIGatewayProxyWebsocketEventV2): Ctx {
  store ??= new DynamoStore();
  return {
    store,
    pusher: apiGatewayPusher(event.requestContext.domainName, event.requestContext.stage),
    now: () => Date.now(),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export const ok: APIGatewayProxyResultV2 = { statusCode: 200, body: "" };
