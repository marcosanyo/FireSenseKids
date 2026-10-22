/**
 * WebSocket routes: telemetry, heartbeat, viewing_state, $default (everything else, incl. the
 * parent phone's camera_status / camera_command / rtc_signal).
 * Forwards small JSON to the peer devices of the same session.
 */
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { onMessage } from "../lib/relay-core";
import { ok, wsContext } from "../lib/ws";

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  await onMessage(wsContext(event), event.requestContext.connectionId, event.body);
  return ok;
}
