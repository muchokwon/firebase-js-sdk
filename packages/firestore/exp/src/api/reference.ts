/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseFirestore } from './database';
import {
  _DocumentKeyReference,
  ParsedUpdateData,
  parseSetData,
  parseUpdateData,
  parseUpdateVarargs
} from '../../../src/api/user_data_reader';
import { debugAssert } from '../../../src/util/assert';
import { cast } from '../../../lite/src/api/util';
import { DocumentSnapshot, QuerySnapshot } from './snapshot';
import {
  applyFirestoreDataConverter,
  SnapshotMetadata,
  validateHasExplicitOrderByForLimitToLast
} from '../../../src/api/database';
import { ViewSnapshot } from '../../../src/core/view_snapshot';
import {
  CollectionReference,
  doc,
  DocumentReference,
  newUserDataReader,
  Query,
  SetOptions,
  UpdateData
} from '../../../lite/src/api/reference';
import { Document } from '../../../src/model/document';
import {
  DeleteMutation,
  Mutation,
  Precondition
} from '../../../src/model/mutation';
import { FieldPath } from '../../../lite/src/api/field_path';
import {
  CompleteFn,
  ErrorFn,
  isPartialObserver,
  NextFn,
  PartialObserver,
  Unsubscribe
} from '../../../src/api/observer';
import { getEventManager, getLocalStore, getSyncEngine } from './components';
import {
  executeQueryViaSnapshotListener,
  readDocumentViaSnapshotListener,
  readDocumentFromCache,
  executeQueryFromCache
} from '../../../src/core/firestore_client';
import {
  newQueryForPath,
  Query as InternalQuery
} from '../../../src/core/query';
import { Deferred } from '../../../src/util/promise';
import { syncEngineWrite } from '../../../src/core/sync_engine';
import { AsyncObserver } from '../../../src/util/async_observer';
import {
  addSnapshotsInSyncListener,
  eventManagerListen,
  eventManagerUnlisten,
  QueryListener,
  removeSnapshotsInSyncListener
} from '../../../src/core/event_manager';
import { FirestoreError } from '../../../src/util/error';

export interface SnapshotListenOptions {
  readonly includeMetadataChanges?: boolean;
}

export function getDoc<T>(
  reference: DocumentReference<T>
): Promise<DocumentSnapshot<T>> {
  const ref = cast<DocumentReference<T>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const deferred = new Deferred<ViewSnapshot>();
  firestore._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestore);
    await readDocumentViaSnapshotListener(
      eventManager,
      firestore._queue,
      ref._key,
      { source: 'default' },
      deferred
    );
  });
  return deferred.promise.then(snapshot =>
    convertToDocSnapshot(firestore, ref, snapshot)
  );
}

export function getDocFromCache<T>(
  reference: DocumentReference<T>
): Promise<DocumentSnapshot<T>> {
  const ref = cast<DocumentReference<T>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const deferred = new Deferred<Document | null>();
  firestore._queue.enqueueAndForget(async () => {
    const localStore = await getLocalStore(firestore);
    await readDocumentFromCache(localStore, ref._key, deferred);
  });
  return deferred.promise.then(
    doc =>
      new DocumentSnapshot(
        firestore,
        ref._key,
        doc,
        new SnapshotMetadata(
          doc instanceof Document ? doc.hasLocalMutations : false,
          /* fromCache= */ true
        ),
        ref._converter
      )
  );
}

export function getDocFromServer<T>(
  reference: DocumentReference<T>
): Promise<DocumentSnapshot<T>> {
  const ref = cast<DocumentReference<T>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const deferred = new Deferred<ViewSnapshot>();
  firestore._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestore);
    await readDocumentViaSnapshotListener(
      eventManager,
      firestore._queue,
      ref._key,
      { source: 'server' },
      deferred
    );
  });
  return deferred.promise.then(snapshot =>
    convertToDocSnapshot(firestore, ref, snapshot)
  );
}

export function getDocs<T>(query: Query<T>): Promise<QuerySnapshot<T>> {
  const internalQuery = cast<Query<T>>(query, Query);
  const firestore = cast(query.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  validateHasExplicitOrderByForLimitToLast(internalQuery._query);

  const deferred = new Deferred<ViewSnapshot>();
  firestore._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestore);
    await executeQueryViaSnapshotListener(
      eventManager,
      firestore._queue,
      internalQuery._query,
      { source: 'default' },
      deferred
    );
  });
  return deferred.promise.then(
    snapshot => new QuerySnapshot(firestore, internalQuery, snapshot)
  );
}

export function getDocsFromCache<T>(
  query: Query<T>
): Promise<QuerySnapshot<T>> {
  const internalQuery = cast<Query<T>>(query, Query);
  const firestore = cast(query.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const deferred = new Deferred<ViewSnapshot>();
  firestore._queue.enqueueAndForget(async () => {
    const localStore = await getLocalStore(firestore);
    await executeQueryFromCache(localStore, internalQuery._query, deferred);
  });
  return deferred.promise.then(
    snapshot => new QuerySnapshot(firestore, internalQuery, snapshot)
  );
}

export function getDocsFromServer<T>(
  query: Query<T>
): Promise<QuerySnapshot<T>> {
  const internalQuery = cast<Query<T>>(query, Query);
  const firestore = cast(query.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const deferred = new Deferred<ViewSnapshot>();
  firestore._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestore);
    await executeQueryViaSnapshotListener(
      eventManager,
      firestore._queue,
      internalQuery._query,
      { source: 'server' },
      deferred
    );
  });
  return deferred.promise.then(
    snapshot => new QuerySnapshot(firestore, internalQuery, snapshot)
  );
}

export function setDoc<T>(
  reference: DocumentReference<T>,
  data: T
): Promise<void>;
export function setDoc<T>(
  reference: DocumentReference<T>,
  data: Partial<T>,
  options: SetOptions
): Promise<void>;
export function setDoc<T>(
  reference: DocumentReference<T>,
  data: T,
  options?: SetOptions
): Promise<void> {
  const ref = cast<DocumentReference<T>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const convertedValue = applyFirestoreDataConverter(
    ref._converter,
    data,
    options
  );
  const dataReader = newUserDataReader(firestore);
  const parsed = parseSetData(
    dataReader,
    'setDoc',
    ref._key,
    convertedValue,
    ref._converter !== null,
    options
  );

  const mutations = parsed.toMutations(ref._key, Precondition.none());
  return executeWrite(firestore, mutations);
}

export function updateDoc(
  reference: DocumentReference<unknown>,
  data: UpdateData
): Promise<void>;
export function updateDoc(
  reference: DocumentReference<unknown>,
  field: string | FieldPath,
  value: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void>;
export function updateDoc(
  reference: DocumentReference<unknown>,
  fieldOrUpdateData: string | FieldPath | UpdateData,
  value?: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void> {
  const ref = cast<DocumentReference<unknown>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const dataReader = newUserDataReader(firestore);

  let parsed: ParsedUpdateData;
  if (
    typeof fieldOrUpdateData === 'string' ||
    fieldOrUpdateData instanceof FieldPath
  ) {
    parsed = parseUpdateVarargs(
      dataReader,
      'updateDoc',
      ref._key,
      fieldOrUpdateData,
      value,
      moreFieldsAndValues
    );
  } else {
    parsed = parseUpdateData(
      dataReader,
      'updateDoc',
      ref._key,
      fieldOrUpdateData
    );
  }

  const mutations = parsed.toMutations(ref._key, Precondition.exists(true));
  return executeWrite(firestore, mutations);
}

export function deleteDoc(reference: DocumentReference): Promise<void> {
  const ref = cast<DocumentReference<unknown>>(reference, DocumentReference);
  const firestore = cast(ref.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const mutations = [new DeleteMutation(ref._key, Precondition.none())];
  return executeWrite(firestore, mutations);
}

export function addDoc<T>(
  reference: CollectionReference<T>,
  data: T
): Promise<DocumentReference<T>> {
  const collRef = cast<CollectionReference<T>>(reference, CollectionReference);
  const firestore = cast(collRef.firestore, FirebaseFirestore);
  firestore._verifyNotTerminated();

  const docRef = doc(collRef);
  const convertedValue = applyFirestoreDataConverter(collRef.converter, data);

  const dataReader = newUserDataReader(collRef.firestore);
  const parsed = parseSetData(
    dataReader,
    'addDoc',
    docRef._key,
    convertedValue,
    collRef.converter !== null,
    {}
  );

  const mutations = parsed.toMutations(docRef._key, Precondition.exists(false));
  return executeWrite(firestore, mutations).then(() => docRef);
}

// TODO(firestorexp): Make sure these overloads are tested via the Firestore
// integration tests
export function onSnapshot<T>(
  reference: DocumentReference<T>,
  observer: {
    next?: (snapshot: DocumentSnapshot<T>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;
export function onSnapshot<T>(
  reference: DocumentReference<T>,
  options: SnapshotListenOptions,
  observer: {
    next?: (snapshot: DocumentSnapshot<T>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;
export function onSnapshot<T>(
  reference: DocumentReference<T>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;
export function onSnapshot<T>(
  reference: DocumentReference<T>,
  options: SnapshotListenOptions,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;
export function onSnapshot<T>(
  query: Query<T>,
  observer: {
    next?: (snapshot: QuerySnapshot<T>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;
export function onSnapshot<T>(
  query: Query<T>,
  options: SnapshotListenOptions,
  observer: {
    next?: (snapshot: QuerySnapshot<T>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;
export function onSnapshot<T>(
  query: Query<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;
export function onSnapshot<T>(
  query: Query<T>,
  options: SnapshotListenOptions,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;
export function onSnapshot<T>(
  ref: Query<T> | DocumentReference<T>,
  ...args: unknown[]
): Unsubscribe {
  let options: SnapshotListenOptions = {
    includeMetadataChanges: false
  };
  let currArg = 0;
  if (typeof args[currArg] === 'object' && !isPartialObserver(args[currArg])) {
    options = args[currArg] as SnapshotListenOptions;
    currArg++;
  }

  const internalOptions = {
    includeMetadataChanges: options.includeMetadataChanges
  };

  if (isPartialObserver(args[currArg])) {
    const userObserver = args[currArg] as PartialObserver<QuerySnapshot<T>>;
    args[currArg] = userObserver.next?.bind(userObserver);
    args[currArg + 1] = userObserver.error?.bind(userObserver);
    args[currArg + 2] = userObserver.complete?.bind(userObserver);
  }

  let observer: PartialObserver<ViewSnapshot>;
  let firestore: FirebaseFirestore;
  let internalQuery: InternalQuery;

  if (ref instanceof DocumentReference) {
    firestore = cast(ref.firestore, FirebaseFirestore);
    internalQuery = newQueryForPath(ref._key.path);

    observer = {
      next: snapshot => {
        if (args[currArg]) {
          (args[currArg] as NextFn<DocumentSnapshot<T>>)(
            convertToDocSnapshot(firestore, ref, snapshot)
          );
        }
      },
      error: args[currArg + 1] as ErrorFn,
      complete: args[currArg + 2] as CompleteFn
    };
  } else {
    const query = cast<Query<T>>(ref, Query);
    firestore = cast(query.firestore, FirebaseFirestore);
    internalQuery = query._query;

    observer = {
      next: snapshot => {
        if (args[currArg]) {
          (args[currArg] as NextFn<QuerySnapshot<T>>)(
            new QuerySnapshot(firestore, query, snapshot)
          );
        }
      },
      error: args[currArg + 1] as ErrorFn,
      complete: args[currArg + 2] as CompleteFn
    };

    validateHasExplicitOrderByForLimitToLast(query._query);
  }

  firestore._verifyNotTerminated();

  const wrappedObserver = new AsyncObserver(observer);
  const listener = new QueryListener(
    internalQuery,
    wrappedObserver,
    internalOptions
  );
  firestore._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestore);
    return eventManagerListen(eventManager, listener);
  });

  return () => {
    wrappedObserver.mute();
    firestore._queue.enqueueAndForget(async () => {
      const eventManager = await getEventManager(firestore);
      return eventManagerUnlisten(eventManager, listener);
    });
  };
}

// TODO(firestorexp): Make sure these overloads are tested via the Firestore
// integration tests
export function onSnapshotsInSync(
  firestore: FirebaseFirestore,
  observer: {
    next?: (value: void) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;
export function onSnapshotsInSync(
  firestore: FirebaseFirestore,
  onSync: () => void
): Unsubscribe;
export function onSnapshotsInSync(
  firestore: FirebaseFirestore,
  arg: unknown
): Unsubscribe {
  const firestoreImpl = cast(firestore, FirebaseFirestore);
  firestoreImpl._verifyNotTerminated();

  const observer = isPartialObserver(arg)
    ? (arg as PartialObserver<void>)
    : {
        next: arg as () => void
      };

  const wrappedObserver = new AsyncObserver(observer);
  firestoreImpl._queue.enqueueAndForget(async () => {
    const eventManager = await getEventManager(firestoreImpl);
    addSnapshotsInSyncListener(eventManager, wrappedObserver);
  });

  return () => {
    wrappedObserver.mute();
    firestoreImpl._queue.enqueueAndForget(async () => {
      const eventManager = await getEventManager(firestoreImpl);
      removeSnapshotsInSyncListener(eventManager, wrappedObserver);
    });
  };
}

/** Locally writes `mutations` on the async queue. */
export function executeWrite(
  firestore: FirebaseFirestore,
  mutations: Mutation[]
): Promise<void> {
  const deferred = new Deferred<void>();
  firestore._queue.enqueueAndForget(async () => {
    const syncEngine = await getSyncEngine(firestore);
    return syncEngineWrite(syncEngine, mutations, deferred);
  });
  return deferred.promise;
}

/**
 * Converts a ViewSnapshot that contains the single document specified by `ref`
 * to a DocumentSnapshot.
 */
function convertToDocSnapshot<T>(
  firestore: FirebaseFirestore,
  ref: _DocumentKeyReference<T>,
  snapshot: ViewSnapshot
): DocumentSnapshot<T> {
  debugAssert(
    snapshot.docs.size <= 1,
    'Expected zero or a single result on a document-only query'
  );
  const doc = snapshot.docs.get(ref._key);

  return new DocumentSnapshot(
    firestore,
    ref._key,
    doc,
    new SnapshotMetadata(snapshot.hasPendingWrites, snapshot.fromCache),
    ref._converter
  );
}
