# testkit

Tools shared by the bridge and executions tests: a local bridge in front of the mock agent
(`mockBridge`), a key pair (`keys`) and a WebSocket client that keeps everything it receives
(`Collector`). Never shipped in an image.

The local bridge speaks raw ACP lines. `Collector` can read raw bridge lines or numbered consumer
frames, and records the instance upgrade header and socket close reason.

`mockBridge` can delay initialization to exercise a restart with the handshake still pending.
