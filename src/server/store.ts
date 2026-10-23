import type { DatabaseSync } from "node:sqlite";
import { StoreDatabase } from "./store-database.js";
import { AccountRepository } from "./store-accounts.js";
import { DeviceRepository } from "./store-devices.js";
import { PersonalRepository } from "./store-personal.js";
import { DraftRepository } from "./store-drafts.js";
import { PresentationRepository } from "./store-presentation.js";
import { SubmissionRepository } from "./store-submissions.js";
import { RoutineRepository } from "./store-routines.js";
import { NotificationRepository } from "./store-notifications.js";
import { EventRepository } from "./store-events.js";
import { RetentionRepository } from "./store-retention.js";

export { schemaVersion } from "./store-database.js";
export type { LiveActivityRegistration } from "./store-devices.js";
export type { RejectionReason } from "./store-submissions.js";
export { maxDeliveryAttempts, presenceTtl, type ChatPresence } from "./store-notifications.js";

/**
 * The app database: one SQLite connection shared by a repository per area. Each repository
 * owns its tables' SQL; one that needs another area's rule takes that repository as a
 * collaborator, so cross-area work stays inside one transaction and one set of in-memory
 * versions. These methods forward to the owning repository and keep existing callers unchanged.
 */
export class Store {
  private readonly database: StoreDatabase;
  readonly db: DatabaseSync;
  readonly accounts: AccountRepository;
  readonly devices: DeviceRepository;
  readonly personalState: PersonalRepository;
  readonly drafts: DraftRepository;
  readonly presentations: PresentationRepository;
  readonly submissions: SubmissionRepository;
  readonly routines: RoutineRepository;
  readonly notifications: NotificationRepository;
  readonly events: EventRepository;
  readonly retention: RetentionRepository;
  constructor(path: string) {
    this.database = new StoreDatabase(path);
    this.db = this.database.db;
    this.accounts = new AccountRepository(this.database);
    this.devices = new DeviceRepository(this.database, this.accounts);
    this.personalState = new PersonalRepository(this.database);
    this.drafts = new DraftRepository(this.database);
    this.presentations = new PresentationRepository(this.database);
    this.submissions = new SubmissionRepository(this.database, this.drafts);
    this.routines = new RoutineRepository(this.database);
    this.notifications = new NotificationRepository(this.database, {
      accounts: this.accounts, personal: this.personalState, presentation: this.presentations,
      routines: this.routines, submissions: this.submissions,
    });
    this.events = new EventRepository(this.database, this.notifications, this.presentations);
    this.retention = new RetentionRepository(this.database, this.accounts, this.personalState);
  }
  close() {
    this.database.close();
  }
  transaction<T>(fn: () => T): T {
    return this.database.transaction(fn);
  }
  /** Advances whenever an assistant's sharing or owner changes, so a request can tell it changed meanwhile. */
  get privacyVersion() { return this.presentations.privacyVersion; }
  /** Assistant display names for notification titles, refreshed by the background worker. */
  get botNames() { return this.notifications.botNames; }
  set botNames(names: Map<string, string>) { this.notifications.botNames = names; }
  // accounts
  user(...args: Parameters<AccountRepository["user"]>) { return this.accounts.user(...args); }
  users(...args: Parameters<AccountRepository["users"]>) { return this.accounts.users(...args); }
  getUser(...args: Parameters<AccountRepository["getUser"]>) { return this.accounts.getUser(...args); }
  session(...args: Parameters<AccountRepository["session"]>) { return this.accounts.session(...args); }
  getSession(...args: Parameters<AccountRepository["getSession"]>) { return this.accounts.getSession(...args); }
  deleteSession(...args: Parameters<AccountRepository["deleteSession"]>) { return this.accounts.deleteSession(...args); }
  confirmSession(...args: Parameters<AccountRepository["confirmSession"]>) { return this.accounts.confirmSession(...args); }
  sessionConfirmedAt(...args: Parameters<AccountRepository["sessionConfirmedAt"]>) { return this.accounts.sessionConfirmedAt(...args); }
  nativeSession(...args: Parameters<AccountRepository["nativeSession"]>) { return this.accounts.nativeSession(...args); }
  getNativeSession(...args: Parameters<AccountRepository["getNativeSession"]>) { return this.accounts.getNativeSession(...args); }
  deleteNativeSession(...args: Parameters<AccountRepository["deleteNativeSession"]>) { return this.accounts.deleteNativeSession(...args); }
  pruneNativeAuth(...args: Parameters<AccountRepository["pruneNativeAuth"]>) { return this.accounts.pruneNativeAuth(...args); }
  nativeFlow(...args: Parameters<AccountRepository["nativeFlow"]>) { return this.accounts.nativeFlow(...args); }
  getNativeFlow(...args: Parameters<AccountRepository["getNativeFlow"]>) { return this.accounts.getNativeFlow(...args); }
  finishNativeFlow(...args: Parameters<AccountRepository["finishNativeFlow"]>) { return this.accounts.finishNativeFlow(...args); }
  consumeNativeCode(...args: Parameters<AccountRepository["consumeNativeCode"]>) { return this.accounts.consumeNativeCode(...args); }
  // devices
  registerNativeDevice(...args: Parameters<DeviceRepository["registerNativeDevice"]>) { return this.devices.registerNativeDevice(...args); }
  removeNativeDevice(...args: Parameters<DeviceRepository["removeNativeDevice"]>) { return this.devices.removeNativeDevice(...args); }
  nativeDevices(...args: Parameters<DeviceRepository["nativeDevices"]>) { return this.devices.nativeDevices(...args); }
  registerLiveActivity(...args: Parameters<DeviceRepository["registerLiveActivity"]>) { return this.devices.registerLiveActivity(...args); }
  liveActivityContext(...args: Parameters<DeviceRepository["liveActivityContext"]>) { return this.devices.liveActivityContext(...args); }
  removeLiveActivity(...args: Parameters<DeviceRepository["removeLiveActivity"]>) { return this.devices.removeLiveActivity(...args); }
  liveActivities(...args: Parameters<DeviceRepository["liveActivities"]>) { return this.devices.liveActivities(...args); }
  liveActivityObserved(...args: Parameters<DeviceRepository["liveActivityObserved"]>) { return this.devices.liveActivityObserved(...args); }
  liveActivitySent(...args: Parameters<DeviceRepository["liveActivitySent"]>) { return this.devices.liveActivitySent(...args); }
  liveActivityFailed(...args: Parameters<DeviceRepository["liveActivityFailed"]>) { return this.devices.liveActivityFailed(...args); }
  // personal
  preferences(...args: Parameters<PersonalRepository["preferences"]>) { return this.personalState.preferences(...args); }
  savePreferences(...args: Parameters<PersonalRepository["savePreferences"]>) { return this.personalState.savePreferences(...args); }
  personal(...args: Parameters<PersonalRepository["personal"]>) { return this.personalState.personal(...args); }
  savePersonal(...args: Parameters<PersonalRepository["savePersonal"]>) { return this.personalState.savePersonal(...args); }
  cardState(...args: Parameters<PersonalRepository["cardState"]>) { return this.personalState.cardState(...args); }
  saveCardState(...args: Parameters<PersonalRepository["saveCardState"]>) { return this.personalState.saveCardState(...args); }
  savedItems(...args: Parameters<PersonalRepository["savedItems"]>) { return this.personalState.savedItems(...args); }
  saveItem(...args: Parameters<PersonalRepository["saveItem"]>) { return this.personalState.saveItem(...args); }
  deleteSavedItem(...args: Parameters<PersonalRepository["deleteSavedItem"]>) { return this.personalState.deleteSavedItem(...args); }
  // drafts
  draft(...args: Parameters<DraftRepository["draft"]>) { return this.drafts.draft(...args); }
  saveDraft(...args: Parameters<DraftRepository["saveDraft"]>) { return this.drafts.saveDraft(...args); }
  clearSubmittedDraft(...args: Parameters<DraftRepository["clearSubmittedDraft"]>) { return this.drafts.clearSubmittedDraft(...args); }
  // presentation
  presentation(...args: Parameters<PresentationRepository["presentation"]>) { return this.presentations.presentation(...args); }
  changedSince(...args: Parameters<PresentationRepository["changedSince"]>) { return this.presentations.changedSince(...args); }
  privateBots(...args: Parameters<PresentationRepository["privateBots"]>) { return this.presentations.privateBots(...args); }
  rememberNames(...args: Parameters<PresentationRepository["rememberNames"]>) { return this.presentations.rememberNames(...args); }
  nameHistory(...args: Parameters<PresentationRepository["nameHistory"]>) { return this.presentations.nameHistory(...args); }
  visibilityPeriods(...args: Parameters<PresentationRepository["visibilityPeriods"]>) { return this.presentations.visibilityPeriods(...args); }
  mayReceive(...args: Parameters<PresentationRepository["mayReceive"]>) { return this.presentations.mayReceive(...args); }
  savePresentation(...args: Parameters<PresentationRepository["savePresentation"]>) { return this.presentations.savePresentation(...args); }
  swapPresentation(...args: Parameters<PresentationRepository["swapPresentation"]>) { return this.presentations.swapPresentation(...args); }
  restorePresentation(...args: Parameters<PresentationRepository["restorePresentation"]>) { return this.presentations.restorePresentation(...args); }
  saveAvatar(...args: Parameters<PresentationRepository["saveAvatar"]>) { return this.presentations.saveAvatar(...args); }
  // submissions
  intent(...args: Parameters<SubmissionRepository["intent"]>) { return this.submissions.intent(...args); }
  submission(...args: Parameters<SubmissionRepository["submission"]>) { return this.submissions.submission(...args); }
  submissionForMessage(...args: Parameters<SubmissionRepository["submissionForMessage"]>) { return this.submissions.submissionForMessage(...args); }
  pending(...args: Parameters<SubmissionRepository["pending"]>) { return this.submissions.pending(...args); }
  receipt(...args: Parameters<SubmissionRepository["receipt"]>) { return this.submissions.receipt(...args); }
  participate(...args: Parameters<SubmissionRepository["participate"]>) { return this.submissions.participate(...args); }
  participants(...args: Parameters<SubmissionRepository["participants"]>) { return this.submissions.participants(...args); }
  attributeApproval(...args: Parameters<SubmissionRepository["attributeApproval"]>) { return this.submissions.attributeApproval(...args); }
  approval(...args: Parameters<SubmissionRepository["approval"]>) { return this.submissions.approval(...args); }
  // routines
  routineRecipients(...args: Parameters<RoutineRepository["routineRecipients"]>) { return this.routines.routineRecipients(...args); }
  getRoutineRecipients(...args: Parameters<RoutineRepository["getRoutineRecipients"]>) { return this.routines.getRoutineRecipients(...args); }
  routineTrial(...args: Parameters<RoutineRepository["routineTrial"]>) { return this.routines.routineTrial(...args); }
  routineTrials(...args: Parameters<RoutineRepository["routineTrials"]>) { return this.routines.routineTrials(...args); }
  rememberRoutineTrial(...args: Parameters<RoutineRepository["rememberRoutineTrial"]>) { return this.routines.rememberRoutineTrial(...args); }
  recordRoutineTrialStatus(...args: Parameters<RoutineRepository["recordRoutineTrialStatus"]>) { return this.routines.recordRoutineTrialStatus(...args); }
  // notifications
  recipients(...args: Parameters<NotificationRepository["recipients"]>) { return this.notifications.recipients(...args); }
  queueNotification(...args: Parameters<NotificationRepository["queueNotification"]>) { return this.notifications.queueNotification(...args); }
  enqueue(...args: Parameters<NotificationRepository["enqueue"]>) { return this.notifications.enqueue(...args); }
  chatPresence(...args: Parameters<NotificationRepository["chatPresence"]>) { return this.notifications.chatPresence(...args); }
  seenInChat(...args: Parameters<NotificationRepository["seenInChat"]>) { return this.notifications.seenInChat(...args); }
  readOnDevices(...args: Parameters<NotificationRepository["readOnDevices"]>) { return this.notifications.readOnDevices(...args); }
  markCleared(...args: Parameters<NotificationRepository["markCleared"]>) { return this.notifications.markCleared(...args); }
  subscribe(...args: Parameters<NotificationRepository["subscribe"]>) { return this.notifications.subscribe(...args); }
  unsubscribe(...args: Parameters<NotificationRepository["unsubscribe"]>) { return this.notifications.unsubscribe(...args); }
  hasSubscription(...args: Parameters<NotificationRepository["hasSubscription"]>) { return this.notifications.hasSubscription(...args); }
  subscriptions(...args: Parameters<NotificationRepository["subscriptions"]>) { return this.notifications.subscriptions(...args); }
  outbox(...args: Parameters<NotificationRepository["outbox"]>) { return this.notifications.outbox(...args); }
  deliveryGroups(...args: Parameters<NotificationRepository["deliveryGroups"]>) { return this.notifications.deliveryGroups(...args); }
  delivered(...args: Parameters<NotificationRepository["delivered"]>) { return this.notifications.delivered(...args); }
  markDelivered(...args: Parameters<NotificationRepository["markDelivered"]>) { return this.notifications.markDelivered(...args); }
  finishDelivery(...args: Parameters<NotificationRepository["finishDelivery"]>) { return this.notifications.finishDelivery(...args); }
  retryDelivery(...args: Parameters<NotificationRepository["retryDelivery"]>) { return this.notifications.retryDelivery(...args); }
  expireNotifications(...args: Parameters<NotificationRepository["expireNotifications"]>) { return this.notifications.expireNotifications(...args); }
  // events
  cursor(...args: Parameters<EventRepository["cursor"]>) { return this.events.cursor(...args); }
  recordEvents(...args: Parameters<EventRepository["recordEvents"]>) { return this.events.recordEvents(...args); }
  enqueueKnownEvents(...args: Parameters<EventRepository["enqueueKnownEvents"]>) { return this.events.enqueueKnownEvents(...args); }
  latestEventFrontier(...args: Parameters<EventRepository["latestEventFrontier"]>) { return this.events.latestEventFrontier(...args); }
  eventPage(...args: Parameters<EventRepository["eventPage"]>) { return this.events.eventPage(...args); }
  todaySeen(...args: Parameters<EventRepository["todaySeen"]>) { return this.events.todaySeen(...args); }
  todayFrontier(...args: Parameters<EventRepository["todayFrontier"]>) { return this.events.todayFrontier(...args); }
  markTodaySeen(...args: Parameters<EventRepository["markTodaySeen"]>) { return this.events.markTodaySeen(...args); }
  // retention
  forgetBot(...args: Parameters<RetentionRepository["forgetBot"]>) { return this.retention.forgetBot(...args); }
  pruneRetention(...args: Parameters<RetentionRepository["pruneRetention"]>) { return this.retention.pruneRetention(...args); }
}
