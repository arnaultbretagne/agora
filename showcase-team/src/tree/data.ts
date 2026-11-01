// Production data, read on 2026-11-01: the person's 12 most recent rows and their three team runs, each
// member under the lead its Prefect run names (members are uuid5("<run>/<member>")). Generated: do not edit.
export interface Row { id: string; title: string; state: string; harness: string | null; question: string | null; changedAt: string; member?: string }
export interface Team { lead: Row; run: string; members: Row[] }
export const RECENT: Row[] = [
 {
  "id": "8deefcc5-4ac7-4b8a-aeb0-512dfefb4782",
  "title": "K7 Pro clavier multi-machines avec souris",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-31T21:51:20.516Z"
 },
 {
  "id": "8c71458c-bf3e-409b-a958-271ec7666330",
  "title": "Reprise recherche avec limite mémoire",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-31T20:59:08.478Z"
 },
 {
  "id": "5d2abbb2-887e-475a-8917-826f674a400c",
  "title": "Chant du loup et sonar",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-30T21:09:09.908Z"
 },
 {
  "id": "20ebd0fb-b770-40d0-b842-73bff5f55ac6",
  "title": "Héberger Obsidian en ligne",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-30T16:41:45.134Z"
 },
 {
  "id": "839e5312-5fe9-4933-be19-5559f766f615",
  "title": "PS5 Pro GPU performance comparisons",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-29T16:21:18.322Z"
 },
 {
  "id": "3784aab2-bfbc-53a5-93a2-78ce6bb5d31e",
  "title": "login-successful",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T22:29:27.883Z"
 },
 {
  "id": "4b07f752-37c1-4963-81da-89b7ef25b9e2",
  "title": "Conception bloc de refroidissement liquide",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T22:25:59.456Z"
 },
 {
  "id": "6eb354d1-a6e1-5354-b4ca-a5eb31deaba6",
  "title": "agent-runtime deletion review",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T21:35:41.068Z"
 },
 {
  "id": "7dd3a904-0f3c-514f-ad61-b85c168a4f4f",
  "title": "agora workstream api integration",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T21:25:32.349Z"
 },
 {
  "id": "907ac476-f1d3-4427-b2e8-e01d93232478",
  "title": "Gateway 1.6.0 with oauth2-proxy",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T20:43:35.416Z"
 },
 {
  "id": "3eae7eb1-4560-5476-a80d-1e3d8c6484c6",
  "title": "webos player limitations research",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T15:17:37.980Z"
 },
 {
  "id": "10704856-bc20-4aee-8e33-9293d3268433",
  "title": "WebOS port pour VLC",
  "state": "ended",
  "harness": "claude-code",
  "question": null,
  "changedAt": "2026-10-28T12:53:59.402Z"
 }
]
export const TEAMS: Team[] = [
 {
  "lead": {
   "id": "5f333cc8-c205-462f-adb0-7bba2c615f13",
   "title": "Audit de sécurité et architecture",
   "state": "ended",
   "harness": "claude-code",
   "question": null,
   "changedAt": "2026-10-27T22:23:11.098Z"
  },
  "run": "20f795d9",
  "members": [
   {
    "id": "befd8bc0-f406-5042-bcfc-c7c16db961bd",
    "title": "Issue #158 Revue d'architecture",
    "state": "ended",
    "harness": "claude-code",
    "question": null,
    "changedAt": "2026-10-27T22:16:05.369Z",
    "member": "dev-1"
   },
   {
    "id": "c4079f31-f7e0-5000-ace4-52b47ea99c0d",
    "title": "Architecture review verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T22:22:49.857Z",
    "member": "judge-1"
   }
  ]
 },
 {
  "lead": {
   "id": "907ac476-f1d3-4427-b2e8-e01d93232478",
   "title": "Gateway 1.6.0 with oauth2-proxy",
   "state": "ended",
   "harness": "claude-code",
   "question": null,
   "changedAt": "2026-10-28T20:43:35.416Z"
  },
  "run": "2f437cd3",
  "members": [
   {
    "id": "71a66e65-e842-590e-8285-3f95b2665d98",
    "title": "feat/credentials-vault merge with main",
    "state": "ended",
    "harness": "claude-code",
    "question": null,
    "changedAt": "2026-10-28T20:13:28.768Z",
    "member": "dev-1"
   },
   {
    "id": "668f4dc5-22e9-5571-8c9f-6157bde67910",
    "title": "infra-k8s #301",
    "state": "ended",
    "harness": "claude-code",
    "question": null,
    "changedAt": "2026-10-28T20:14:59.955Z",
    "member": "sre-1"
   },
   {
    "id": "2dbe5fc6-dc8a-5c23-b987-030f8c5815c9",
    "title": "Vault-profile ship readiness review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:19:48.712Z",
    "member": "judge-1"
   },
   {
    "id": "a20bd56b-a898-5178-80ec-901fa6dbdf93",
    "title": "Kubernetes profile verification review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:22:46.965Z",
    "member": "judge-2"
   },
   {
    "id": "0c1953a1-7747-5ef3-b00f-310a4ca2971b",
    "title": "Preview-profile ship verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:26:49.988Z",
    "member": "judge-3"
   },
   {
    "id": "b80e2aad-380c-5c31-b512-9c7e67330d06",
    "title": "Vault-route verification review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:30:28.825Z",
    "member": "judge-4"
   },
   {
    "id": "f98683c1-2771-5626-aaec-5533ff420058",
    "title": "Kubernetes route verification review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:34:11.817Z",
    "member": "judge-5"
   },
   {
    "id": "0f386256-973f-55d0-a7d2-c2a25b57f323",
    "title": "Preview route ship verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-28T20:43:15.131Z",
    "member": "judge-6"
   }
  ]
 },
 {
  "lead": {
   "id": "f9bf8ee3-3ee3-4fa6-aff6-1978399a44de",
   "title": "Credential et session admin navigateur",
   "state": "ended",
   "harness": "claude-code",
   "question": null,
   "changedAt": "2026-10-27T13:31:02.554Z"
  },
  "run": "2f42be87",
  "members": [
   {
    "id": "d0301c05-45df-5876-b431-2e4d13c68a5b",
    "title": "MCP vault grants et profils de sécurité",
    "state": "ended",
    "harness": "claude-code",
    "question": null,
    "changedAt": "2026-10-27T13:47:36.614Z",
    "member": "dev-1"
   },
   {
    "id": "ce2b12f3-942a-578c-a75c-35f0db807354",
    "title": "IDS and MCP_ALLOWED_AUDIENCE",
    "state": "ended",
    "harness": "claude-code",
    "question": null,
    "changedAt": "2026-10-27T14:42:48.175Z",
    "member": "sre-1"
   },
   {
    "id": "6615dfc8-6683-5500-adce-6716400607e1",
    "title": "Vault profile verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-26T23:53:30.634Z",
    "member": "judge-1"
   },
   {
    "id": "0e7f7278-78fc-508a-b62e-2e90f391cf32",
    "title": "Vault profile verification for Agora",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T08:27:07.636Z",
    "member": "judge-2"
   },
   {
    "id": "892e4223-8bc5-559e-855f-c8f2ffa1eb3c",
    "title": "Verification de la route Vault",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T08:41:01.910Z",
    "member": "judge-3"
   },
   {
    "id": "e4e88d02-b33c-5c64-a195-085fad940cc9",
    "title": "Vault-route verification review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T09:06:34.174Z",
    "member": "judge-4"
   },
   {
    "id": "d39a693e-8785-5940-936b-1793ba4aeb92",
    "title": "Vault-route CI verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T09:22:51.791Z",
    "member": "judge-5"
   },
   {
    "id": "1f87c81b-724b-5d23-aa29-af8f8e00859b",
    "title": "Kubernetes profile PR verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T11:06:44.582Z",
    "member": "judge-6"
   },
   {
    "id": "ebf47c18-7b68-5a23-ba37-b3de19b60141",
    "title": "Kubernetes route verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T11:31:26.562Z",
    "member": "judge-7"
   },
   {
    "id": "2da52726-0c2b-5fd8-9b2a-77148bee2783",
    "title": "Kubernetes route cutoff verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T12:09:01.803Z",
    "member": "judge-8"
   },
   {
    "id": "cd380d9c-00d7-521c-8f45-0bb315bb47af",
    "title": "Kubernetes route verification review",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T12:27:44.013Z",
    "member": "judge-9"
   },
   {
    "id": "962a1f1f-6b73-562d-986a-f246cfc17aa1",
    "title": "Verify Kubernetes route implementation",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T13:02:13.737Z",
    "member": "judge-10"
   },
   {
    "id": "7e734506-9c96-5861-acdf-fbd94f575f7b",
    "title": "Kubernetes route verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T13:23:31.929Z",
    "member": "judge-11"
   },
   {
    "id": "3b309d3b-394a-5087-9ce8-c671221e92a3",
    "title": "Preview profile verification",
    "state": "ended",
    "harness": "codex",
    "question": null,
    "changedAt": "2026-10-27T13:30:08.265Z",
    "member": "judge-12"
   }
  ]
 }
]
