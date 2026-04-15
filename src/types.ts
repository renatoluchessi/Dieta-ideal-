export type Gender = 'male' | 'female';
export type GoalType = 'loss' | 'gain' | 'maintenance';

export interface PatientProfile {
  id?: string;
  uid: string;
  name: string;
  age: number;
  gender: Gender;
  weight: number;
  height: number;
  activityFactor: number;
  medicalHistory?: string;
  allergies?: string;
  intolerances?: string;
  goalType?: GoalType;
  goalKcal?: number;
  createdAt: any;
}

export interface UserData {
  gender: Gender;
  weight: number;
  height: number;
  age: number;
  activityFactor: number;
  goalKcal: number;
  goalType: GoalType;
  medicalHistory?: string;
  allergies?: string;
  intolerances?: string;
}

export interface Macronutrients {
  protein: { grams: number; calories: number; percentage: number };
  fat: { grams: number; calories: number; percentage: number };
  carbs: { grams: number; calories: number; percentage: number };
}

export interface MetabolicResults {
  bmr: number;
  tdee: number;
  tev: number;
  macros: Macronutrients;
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
