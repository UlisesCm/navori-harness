# Plan template (`navori master template plan`)

Every section below is a fixed `##` heading (spec 0034, design.md D3). None may stay empty: whatever doesn't apply is written as `Not applicable: <reason>`.

## Metadata

Project, stage (`<NN>-<slug>`), date, mode, this plan's number (`plan1`, `plan2` or `plan3`), the assigned tie-break priority, the `context/md/` files read, and, from stage 2 onward, the closed-stage files read.

## Executive summary

What will be built and why, in one paragraph.

## Current state vs. objective
<!-- only-mode: en-curso -->

Only in `en-curso` mode: what exists in the code today, what's missing for the objective. From stage 2 onward, include what the closed stages delivered.

## Scope (MoSCoW)

Must / Should / Could / Won't, each item observable. From stage 2 onward, the deferred parts the user chose to include go here with their origin (`<NN-slug>/P<n>`).

## Actors and permissions

Role, what it can do, what it can't.

## Business rules

`RN-<n>`, each citing the `context/md/` file it comes from or marked `[ASSUMED]`.

## Functional requirements

`RF-<n>`, observable.

## Non-functional requirements

`RNF-<n>`, each with a measure and a threshold.

## Domain and data

Entities, relationships, lifecycle, retention.

## Architecture

Components, boundaries, main flow.

## Stack and libraries

Name, pinned version, official URL and consultation date, or `[UNVERIFIED]`.

## Contracts

API, events, schemas.

## Security

Authentication, authorization, sensitive data, threats.

## Infrastructure and operations

Environments, deployment, observability, costs.

## Delivery in parts

`P<n>` with objective, scope, out of scope, dependencies, seed requirements and acceptance criteria with id `P<n>.A<m>`. Each criterion has an observable description and its method: `test` (named file and case), `comando` (command and expected result) or `manual` (what the user checks and how). In `en-curso` mode, also its status (`done`, `partial` or `pending`).

## Testing

Strategy per level and which risk each one covers.

## Risks

Risk, likelihood, impact, mitigation.

## Open questions

What the architect could not decide, including any contradiction between the new context and a closed stage's decision.
