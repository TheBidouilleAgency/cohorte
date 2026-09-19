// DESIGN 2.3.2 — one row of the catalogue = a payload schema + a durability. The family files of this directory declare
// rows; catalogue.ts assembles them into EVENTS. Authoring rules (docs/v3/requests/U0.04.md R1): objects are closed by
// the generator, never by the author; no Type.Intersect on a wire shape; OpenEnum where DESIGN says OpenEnum, ClosedEnum
// for every literal union.
import { type TSchema, Type } from 'typebox';

export const durable = <P extends TSchema>(payload: P) => ({ payload, durability: 'durable' }) as const;
export const ephemeral = <P extends TSchema>(payload: P) => ({ payload, durability: 'ephemeral' }) as const;

export const count = () => Type.Integer({ minimum: 0 });
export const milliseconds = () => Type.Number({ minimum: 0 });

/** `{ ref; sha; treeDigest }`: what a review looked at, and what an approval of it is bound to. */
export const ReviewRef = Type.Object({ ref: Type.String(), sha: Type.String(), treeDigest: Type.String() });

export const REPLAY_CLASSES = ['idempotent', 'verifiable', 'at-most-once'] as const;
