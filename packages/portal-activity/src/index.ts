/**
 * 共享活动记录包入口。
 *
 * 两站只从这里取能力，不直接引用包内文件——后续调整内部结构不会波及门户代码。
 */

export {
  ACTIVITY_OBSOLETE_INDEX_STATEMENTS,
  ACTIVITY_RETENTION_DAYS,
  ACTIVITY_SCHEMA_STATEMENTS,
} from './schema';
export {
  createActivityRecorder,
  DEFAULT_LOG_THROTTLE_MS,
  DEFAULT_PRUNE_BATCH_SIZE,
  DEFAULT_PRUNE_INTERVAL_MS,
  DEFAULT_PRUNE_MAX_BATCHES,
  DEFAULT_WRITE_TIMEOUT_MS,
  type ActivityLogger,
  type ActivityRecorder,
  type ActivityRecorderOptions,
  type Db,
} from './record';
export {
  normalizeVisitPath,
  planVisit,
  shouldDedupe,
  VISIT_DEDUPE_WINDOW_MS,
  VISIT_PATH_MAX,
  type VisitPlan,
  type VisitState,
} from './path';
export { reportVisit, type VisitReportResult, type VisitTransport } from './transport';
export { VisitTracker, type VisitTrackerProps } from './VisitTracker';
export type { ActivitySite, LoginEventInput, LoginMethod } from './types';
