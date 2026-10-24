-- Runs that ended before the outcome outbox existed were handled by the old in-process return: mark them returned so the reconciler does not resend them.
UPDATE `wakes` SET `outcome_returned_at` = coalesce(`ended_at`, `created_at`) WHERE `outcome_returned_at` IS NULL AND `status` IN ('done', 'failed', 'interrupted', 'cancelled', 'expired', 'dropped', 'blocked');
