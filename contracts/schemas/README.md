# JSON Schemas

These schemas cover Agora-owned data only:

- equipment catalogue and intent;
- trusted Agent runtime definitions;
- custody metadata;
- journal row representation;
- rebuildable Workstream items;
- rebuildable prompt turns;
- Web feed events.

Workstream item values are typed per kind. Field names follow ACP v2 nomenclature; ACP-owned open
enums (tool kind/status, plan priority/status, stop reasons) stay plain strings transported
verbatim, while Agora-owned closed enums are constrained.

The ACP envelope and content-block properties intentionally do not reproduce ACP's schema. They are
validated with stable types/schema from the pinned `@agentclientprotocol/sdk`.

Fixtures added by implementation plans must include at least one valid and one invalid example for
each schema.
