/**
 * WebSocket routes: $connect, $disconnect, tv_hello, camera_hello, pairing_reset, parent_pairing_request, parent_hello.
 */
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { onConnect, onDisconnect, onMessage, RelayError } from "../lib/relay-core";
import { ok, wsContext } from "../lib/ws";

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string | undefined> };

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const ctx = wsContext(event);
  const { connectionId, routeKey } = event.requestContext;
  if (routeKey === "$connect") {
    try {
      await onConnect(ctx, connectionId, event.queryStringParameters?.role);
      return ok;
    } catch (err) {
      if (err instanceof RelayError) return { statusCode: 400, body: err.message };
      throw err;
    }
  }
  if (routeKey === "$disconnect") {
    await onDisconnect(ctx, connectionId);
    return ok;
  }
  await onMessage(ctx, connectionId, event.body);
  return ok;
}
