export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface SnapshotRecord<View> { value: View; change?: JsonValue }
export type Transaction<State, Result> =
  | { state: State; result: Result; commit?: boolean }
  | { state?: State; result: Result; commit: false };
export interface SnapshotStore<State, View> {
  readonly file: string;
  read(): State;
  snapshot(): View;
  subscribe(listener: (record: SnapshotRecord<View>) => unknown): () => void;
  transact<Result>(
    reducer: (draft: State) => Transaction<State, Result> | Promise<Transaction<State, Result>>,
    options?: { change?: JsonValue },
  ): Promise<Result>;
  close(): Promise<void>;
}
export function openSnapshotStore<State, View = State>(options: {
  file: string;
  initial: State | (() => State | Promise<State>);
  validate?: (state: State) => boolean | void;
  project?: (state: State) => View & (View extends PromiseLike<unknown> ? never : unknown);
  onSubscriberError?: (error: unknown) => void;
}): Promise<SnapshotStore<State, View>>;
