import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { ServerMessage } from "../../../../lib/firesense/protocol";

export type PushResult = "ok" | "gone";

export interface Pusher {
  post(connectionId: string, msg: ServerMessage): Promise<PushResult>;
}

const clients = new Map<string, ApiGatewayManagementApiClient>();

/** Pusher bound to the API Gateway stage that invoked the Lambda. */
export function apiGatewayPusher(domainName: string, stage: string): Pusher {
  const endpoint = `https://${domainName}/${stage}`;
  let client = clients.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({ endpoint });
    clients.set(endpoint, client);
  }
  const c = client;
  return {
    async post(connectionId, msg) {
      try {
        await c.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(msg)) }));
        return "ok";
      } catch (err) {
        if (err instanceof GoneException) return "gone";
        throw err;
      }
    },
  };
}
