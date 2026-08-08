/**
 * The Result type lives in @reasoner/schema so every package shares one
 * definition. Re-exported here because the Core is its primary consumer:
 * expected failures return Err, only unrecoverable programmer errors throw.
 */
export {
  err,
  isErr,
  isOk,
  ok,
  type Err,
  type Ok,
  type ReasonerError,
  type ReasonerErrorCode,
  type Result,
} from '@reasoner/schema';
