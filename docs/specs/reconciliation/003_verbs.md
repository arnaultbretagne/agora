# 003 — Verb taxonomy

A verb is the constrained action selected by `ACTION(verb)`. `PASS` and `CONVERGED` are results,
not verbs.

Invoking a verb may change external systems, but has no semantic return value. A verb never returns
an Observation or decides which rule comes next. Once its attempt ends, the reconciler emits the
next `NOTIFY`; only that tick's fresh Observation determines the next result.

The verb catalogue is closed. Before implementation, every verb MUST define its owner, inputs,
idempotency contract and observable postcondition. A rule selects a verb; it does not inline the
verb's procedure or reproduce decisions owned by later rules.

## `TURN_ON`

`TURN_ON` is selected when power is desired `on` and observed `off`. Its observable objective is a
subsequent fresh `observation.power = on`.

## `TURN_OFF`

`TURN_OFF` is selected when power is desired `off` and observed `on`. Its observable objective is a
subsequent fresh `observation.power = off`.

Neither verb returns its postcondition. The next tick obtains a fresh Observation and reevaluates
the rules.
