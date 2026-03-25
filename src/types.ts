export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  createdAt: string;
}

export interface TrackedItem {
  id: string;
  userId: string;
  name: string;
  category?: string;
  lastSearchAt?: string;
  createdAt: string;
}

export interface SaleResult {
  id: string;
  trackedItemId: string;
  userId: string;
  storeName: string;
  price: string;
  originalPrice?: string;
  discount?: string;
  url: string;
  description?: string;
  foundAt: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}
