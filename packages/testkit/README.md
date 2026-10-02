# testkit

Tools shared by the bridge, executions and log tests: a local bridge in front of the mock agent
(`mockBridge`), a key pair (`keys`) and a WebSocket client that keeps everything it receives
(`Collector`). Never shipped in an image.

The local bridge speaks raw ACP lines. `Collector` keeps them, raw and parsed, with the instance
upgrade header and the socket's close reason.

`mockBridge` can delay its answer to `initialize`, or make it invalid.
