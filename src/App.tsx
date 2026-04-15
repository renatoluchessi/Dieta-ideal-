/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { 
  Calculator, 
  User, 
  Activity, 
  Target, 
  AlertTriangle, 
  ClipboardList, 
  PieChart as PieChartIcon,
  RefreshCw,
  ArrowRight,
  Users,
  Plus,
  Save,
  Trash2,
  Stethoscope,
  ShieldAlert,
  Menu,
  X,
  LogOut,
  LogIn,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { UserData, MetabolicResults, Macronutrients, PatientProfile, OperationType, FirestoreErrorInfo } from './types';
import { generateDietPlan } from './lib/gemini';
import { auth, db } from './lib/firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  updateDoc,
  serverTimestamp,
  getDocFromServer,
  setDoc
} from 'firebase/firestore';

const ACTIVITY_FACTORS = [
  { label: 'Sedentário (Pouco ou nenhum exercício)', value: 1.2 },
  { label: 'Levemente Ativo (Exercício leve 1-3 dias/semana)', value: 1.375 },
  { label: 'Moderadamente Ativo (Exercício moderado 3-5 dias/semana)', value: 1.55 },
  { label: 'Altamente Ativo (Exercício pesado 6-7 dias/semana)', value: 1.725 },
  { label: 'Extremamente Ativo (Trabalho físico ou treino intenso)', value: 1.9 },
];

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Ocorreu um erro inesperado.";
      try {
        if (this.state.error?.message) {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && parsed.error.includes('permission-denied')) {
            errorMessage = "Você não tem permissão para realizar esta operação. Verifique se você está logado corretamente.";
          } else if (parsed.error && parsed.error.includes('offline')) {
            errorMessage = "Erro de conexão com o banco de dados. Verifique sua internet ou a configuração do Firebase.";
          }
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen bg-bento-bg flex items-center justify-center p-6">
          <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center border border-red-100">
            <div className="bg-red-50 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-bold text-bento-text-main mb-4">Ops! Algo deu errado</h2>
            <p className="text-bento-text-secondary mb-8 text-sm">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-bento-primary text-white font-bold py-3 rounded-xl hover:bg-teal-700 transition-all"
            >
              Recarregar Aplicativo
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

type View = 'dashboard' | 'profiles' | 'calculator';

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [patients, setPatients] = useState<PatientProfile[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientProfile | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Calculator State
  const [userData, setUserData] = useState<UserData>({
    gender: 'male',
    weight: 70,
    height: 175,
    age: 30,
    activityFactor: 1.55,
    goalKcal: 500,
    goalType: 'loss',
    medicalHistory: '',
    allergies: '',
    intolerances: '',
  });

  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsAuthReady(true);
      
      if (u) {
        // Sync user document
        const path = `users/${u.uid}`;
        try {
          await updateDoc(doc(db, 'users', u.uid), {
            uid: u.uid,
            email: u.email,
            // role is not updated here to prevent self-escalation if rules were weak, 
            // but we can set it on create if we used setDoc with merge
          });
        } catch (err: any) {
          // If document doesn't exist, create it
          if (err.code === 'not-found' || (err.message && err.message.includes('not-found'))) {
            try {
              await setDoc(doc(db, 'users', u.uid), {
                uid: u.uid,
                email: u.email,
                role: 'user'
              });
            } catch (createErr) {
              console.error("Error creating user doc:", createErr);
            }
          }
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Connection Test
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // Patients Listener
  useEffect(() => {
    if (!user || !isAuthReady) {
      setPatients([]);
      return;
    }

    const path = 'patients';
    const q = query(collection(db, path), where('uid', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const pList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as PatientProfile[];
      setPatients(pList);
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, path);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      // auth/cancelled-popup-request happens if the user clicks again or closes the popup
      if (err.code !== 'auth/cancelled-popup-request' && err.code !== 'auth/popup-closed-by-user') {
        console.error("Login Error:", err);
        setError("Erro ao entrar: " + err.message);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => signOut(auth);

  const results = useMemo((): MetabolicResults => {
    const { gender, weight, height, age, activityFactor, goalKcal, goalType } = userData;
    
    const bmr = gender === 'male'
      ? (10 * weight) + (6.25 * height) - (5 * age) + 5
      : (10 * weight) + (6.25 * height) - (5 * age) - 161;

    const tdee = bmr * activityFactor;
    
    let tev = tdee;
    if (goalType === 'loss') tev = tdee - goalKcal;
    else if (goalType === 'gain') tev = tdee + goalKcal;

    const proteinGrams = weight * 2.0;
    const fatGrams = weight * 0.9;
    
    const proteinCalories = proteinGrams * 4;
    const fatCalories = fatGrams * 9;
    
    const remainingCalories = tev - proteinCalories - fatCalories;
    const carbsGrams = Math.max(0, remainingCalories / 4);
    const carbsCalories = carbsGrams * 4;

    const totalCalculatedCalories = proteinCalories + fatCalories + carbsCalories;

    const macros: Macronutrients = {
      protein: { grams: proteinGrams, calories: proteinCalories, percentage: (proteinCalories / totalCalculatedCalories) * 100 },
      fat: { grams: fatGrams, calories: fatCalories, percentage: (fatCalories / totalCalculatedCalories) * 100 },
      carbs: { grams: carbsGrams, calories: carbsCalories, percentage: (carbsCalories / totalCalculatedCalories) * 100 },
    };

    return { bmr, tdee, tev, macros };
  }, [userData]);

  const handleGeneratePlan = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const plan = await generateDietPlan(userData, results);
      setAiResponse(plan || null);
    } catch (err) {
      console.error(err);
      setError('Erro ao gerar plano alimentar. Verifique sua conexão ou tente novamente.');
    } finally {
      setIsLoading(false);
    }
  };

  const savePatient = async (p: Partial<PatientProfile>) => {
    if (!user) return;
    const path = 'patients';
    try {
      if (p.id) {
        const { id, ...data } = p;
        await updateDoc(doc(db, path, id), data);
      } else {
        await addDoc(collection(db, path), {
          ...p,
          uid: user.uid,
          createdAt: serverTimestamp()
        });
      }
      setSelectedPatient(null);
    } catch (err) {
      handleFirestoreError(err, p.id ? OperationType.UPDATE : OperationType.CREATE, path);
    }
  };

  const deletePatient = async (id: string) => {
    const path = 'patients';
    try {
      await deleteDoc(doc(db, path, id));
      if (selectedPatient?.id === id) setSelectedPatient(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const selectPatientForCalc = (p: PatientProfile) => {
    setUserData({
      ...userData,
      gender: p.gender,
      weight: p.weight,
      height: p.height,
      age: p.age,
      activityFactor: p.activityFactor,
      medicalHistory: p.medicalHistory,
      allergies: p.allergies,
      intolerances: p.intolerances,
      goalType: p.goalType || 'loss',
      goalKcal: p.goalKcal || 500
    });
    setCurrentView('calculator');
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-bento-bg flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-bento-primary animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-bento-bg flex flex-col items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center"
        >
          <div className="bg-bento-primary-light w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Calculator className="w-8 h-8 text-bento-primary" />
          </div>
          <h1 className="text-2xl font-bold text-bento-text-main mb-2">NutriClinical AI</h1>
          <p className="text-bento-text-secondary mb-8">Acesse sua conta para gerenciar perfis de pacientes e prescrições dietéticas.</p>
          
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-bento-primary text-white font-bold py-4 rounded-2xl shadow-lg shadow-teal-100 flex items-center justify-center gap-3 hover:bg-teal-700 transition-all disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoggingIn ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <LogIn className="w-5 h-5" /> Entrar com Google
              </>
            )}
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bento-bg flex overflow-hidden">
      {/* Sidebar */}
      <aside className={`bg-white border-r border-bento-border transition-all duration-300 flex flex-col ${isSidebarOpen ? 'w-64' : 'w-20'}`}>
        <div className="p-6 flex items-center gap-3 border-b border-bento-border">
          <div className="bg-bento-primary p-2 rounded-lg shrink-0">
            <Calculator className="w-5 h-5 text-white" />
          </div>
          {isSidebarOpen && <span className="font-bold text-bento-text-main truncate">NutriClinical AI</span>}
        </div>

        <nav className="flex-grow p-4 space-y-2">
          {[
            { id: 'dashboard', label: 'Início', icon: PieChartIcon },
            { id: 'profiles', label: 'Pacientes', icon: Users },
            { id: 'calculator', label: 'Calculadora', icon: Calculator },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id as View)}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${
                currentView === item.id 
                  ? 'bg-bento-primary-light text-bento-primary font-bold' 
                  : 'text-bento-text-secondary hover:bg-bento-bg'
              }`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              {isSidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-bento-border">
          <div className="flex items-center gap-3 p-2 mb-4">
            <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border border-bento-border" />
            {isSidebarOpen && (
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-bento-text-main truncate">{user.displayName}</span>
                <span className="text-[10px] text-bento-text-secondary truncate">{user.email}</span>
              </div>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 p-3 rounded-xl text-red-500 hover:bg-red-50 transition-all"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {isSidebarOpen && <span className="text-sm font-bold">Sair</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-grow flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-bento-border flex items-center justify-between px-6 shrink-0">
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-bento-bg rounded-lg">
            {isSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="text-[10px] px-2 py-1 bg-bento-accent text-white font-bold rounded uppercase">
            {currentView === 'dashboard' ? 'Visão Geral' : currentView === 'profiles' ? 'Gestão de Perfis' : 'Prescrição Ativa'}
          </div>
        </header>

        <div className="flex-grow overflow-y-auto p-6 custom-scrollbar">
          <AnimatePresence mode="wait">
            {currentView === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-white p-6 rounded-3xl border border-bento-border shadow-sm">
                    <div className="text-xs font-bold text-bento-text-secondary uppercase mb-2">Total de Pacientes</div>
                    <div className="text-4xl font-bold text-bento-text-main">{patients.length}</div>
                  </div>
                  <div className="bg-bento-primary p-6 rounded-3xl shadow-lg shadow-teal-100 text-white">
                    <div className="text-xs font-bold opacity-80 uppercase mb-2">Prescrições Hoje</div>
                    <div className="text-4xl font-bold">0</div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl border border-bento-border shadow-sm">
                    <div className="text-xs font-bold text-bento-text-secondary uppercase mb-2">Alertas Clínicos</div>
                    <div className="text-4xl font-bold text-amber-500">0</div>
                  </div>
                </div>

                <div className="bg-white rounded-3xl border border-bento-border overflow-hidden shadow-sm">
                  <div className="p-6 border-b border-bento-border flex justify-between items-center">
                    <h2 className="font-bold text-bento-text-main">Pacientes Recentes</h2>
                    <button onClick={() => setCurrentView('profiles')} className="text-xs font-bold text-bento-primary hover:underline">Ver todos</button>
                  </div>
                  <div className="divide-y divide-bento-border">
                    {patients.slice(0, 5).map(p => (
                      <div key={p.id} className="p-4 flex items-center justify-between hover:bg-bento-bg transition-all cursor-pointer" onClick={() => selectPatientForCalc(p)}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-500">
                            {p.name[0]}
                          </div>
                          <div>
                            <div className="text-sm font-bold text-bento-text-main">{p.name}</div>
                            <div className="text-xs text-bento-text-secondary">{p.weight}kg • {p.age} anos</div>
                          </div>
                        </div>
                        <ArrowRight className="w-4 h-4 text-bento-text-secondary" />
                      </div>
                    ))}
                    {patients.length === 0 && (
                      <div className="p-12 text-center text-bento-text-secondary text-sm">Nenhum paciente cadastrado.</div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {currentView === 'profiles' && (
              <motion.div 
                key="profiles"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex justify-between items-center">
                  <h2 className="text-xl font-bold text-bento-text-main">Gestão de Pacientes</h2>
                  <button 
                    onClick={() => setSelectedPatient({ uid: user.uid, name: '', age: 30, gender: 'male', weight: 70, height: 175, activityFactor: 1.55, createdAt: null })}
                    className="bg-bento-primary text-white px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" /> Novo Paciente
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {patients.map(p => (
                    <div key={p.id} className="bg-white rounded-3xl border border-bento-border p-6 shadow-sm hover:shadow-md transition-all group">
                      <div className="flex justify-between items-start mb-4">
                        <div className="w-12 h-12 bg-bento-primary-light rounded-2xl flex items-center justify-center font-bold text-bento-primary text-xl">
                          {p.name[0]}
                        </div>
                        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                          <button onClick={() => setSelectedPatient(p)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500"><Save className="w-4 h-4" /></button>
                          <button onClick={() => deletePatient(p.id!)} className="p-2 hover:bg-red-50 rounded-lg text-red-500"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                      <h3 className="font-bold text-bento-text-main mb-1">{p.name}</h3>
                      <p className="text-xs text-bento-text-secondary mb-4">{p.age} anos • {p.gender === 'male' ? 'Masculino' : 'Feminino'}</p>
                      
                      <div className="grid grid-cols-2 gap-4 mb-6">
                        <div className="bg-bento-bg p-2 rounded-xl text-center">
                          <div className="text-[10px] font-bold text-bento-text-secondary uppercase">Peso</div>
                          <div className="text-sm font-bold">{p.weight}kg</div>
                        </div>
                        <div className="bg-bento-bg p-2 rounded-xl text-center">
                          <div className="text-[10px] font-bold text-bento-text-secondary uppercase">Altura</div>
                          <div className="text-sm font-bold">{p.height}cm</div>
                        </div>
                      </div>

                      <button 
                        onClick={() => selectPatientForCalc(p)}
                        className="w-full py-2 border border-bento-primary text-bento-primary rounded-xl text-xs font-bold hover:bg-bento-primary hover:text-white transition-all"
                      >
                        Iniciar Prescrição
                      </button>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {currentView === 'calculator' && (
              <motion.div 
                key="calculator"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="grid grid-cols-1 lg:grid-cols-12 gap-6"
              >
                {/* Inputs Column */}
                <div className="lg:col-span-4 space-y-6">
                  <section className="bg-white rounded-3xl border border-bento-border p-6 shadow-sm">
                    <h3 className="font-bold text-bento-text-main mb-6 flex items-center gap-2">
                      <Calculator className="w-5 h-5 text-bento-primary" /> Parâmetros
                    </h3>
                    
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Peso (kg)</label>
                          <input type="number" value={userData.weight} onChange={e => setUserData({...userData, weight: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary" />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Altura (cm)</label>
                          <input type="number" value={userData.height} onChange={e => setUserData({...userData, height: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary" />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Idade</label>
                          <input type="number" value={userData.age} onChange={e => setUserData({...userData, age: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary" />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Objetivo</label>
                          <select 
                            value={userData.goalType} 
                            onChange={e => setUserData({...userData, goalType: e.target.value as any})} 
                            className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary"
                          >
                            <option value="loss">Perda de Peso</option>
                            <option value="gain">Ganho de Peso</option>
                            <option value="maintenance">Manutenção</option>
                          </select>
                        </div>
                      </div>

                      {userData.goalType !== 'maintenance' && (
                        <div>
                          <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">
                            {userData.goalType === 'loss' ? 'Déficit Calórico (kcal)' : 'Superávit Calórico (kcal)'}
                          </label>
                          <input 
                            type="number" 
                            step="50"
                            value={userData.goalKcal} 
                            onChange={e => setUserData({...userData, goalKcal: Number(e.target.value)})} 
                            className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary" 
                          />
                        </div>
                      )}

                      <div>
                        <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Fator Atividade</label>
                        <select value={userData.activityFactor} onChange={e => setUserData({...userData, activityFactor: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-sm outline-none focus:border-bento-primary">
                          {ACTIVITY_FACTORS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                      </div>

                      <div className="pt-4 border-t border-bento-border space-y-4">
                        <h4 className="text-[10px] font-bold text-bento-text-secondary uppercase">Contexto Clínico</h4>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1 flex items-center gap-1"><Stethoscope className="w-3 h-3" /> Histórico Médico</label>
                          <textarea value={userData.medicalHistory} onChange={e => setUserData({...userData, medicalHistory: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-xs outline-none focus:border-bento-primary h-20 resize-none" placeholder="Doenças, medicações..." />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Alergias/Intolerâncias</label>
                          <textarea value={userData.allergies} onChange={e => setUserData({...userData, allergies: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-3 py-2 text-xs outline-none focus:border-bento-primary h-20 resize-none" placeholder="Glúten, lactose, amendoim..." />
                        </div>
                      </div>

                      <button
                        onClick={handleGeneratePlan}
                        disabled={isLoading}
                        className="w-full bg-bento-primary text-white font-bold py-4 rounded-2xl shadow-lg shadow-teal-100 flex items-center justify-center gap-2 hover:bg-teal-700 transition-all"
                      >
                        {isLoading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <>Gerar Prescrição <ArrowRight className="w-5 h-5" /></>}
                      </button>
                    </div>
                  </section>
                </div>

                {/* Results Column */}
                <div className="lg:col-span-8 space-y-6">
                  <section className="bg-white rounded-3xl border border-bento-border p-6 shadow-sm">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                      <div className="bg-bento-bg p-4 rounded-2xl text-center">
                        <div className="text-[10px] font-bold text-bento-text-secondary uppercase mb-1">TMB</div>
                        <div className="text-2xl font-bold text-bento-text-main">{results.bmr.toFixed(0)}</div>
                      </div>
                      <div className="bg-bento-bg p-4 rounded-2xl text-center">
                        <div className="text-[10px] font-bold text-bento-text-secondary uppercase mb-1">GET</div>
                        <div className="text-2xl font-bold text-bento-text-main">{results.tdee.toFixed(0)}</div>
                      </div>
                      <div className="bg-bento-primary-light p-4 rounded-2xl text-center border border-bento-primary/10">
                        <div className="text-[10px] font-bold text-bento-primary uppercase mb-1">VET Final</div>
                        <div className="text-2xl font-bold text-bento-primary">{results.tev.toFixed(0)}</div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {[
                        { label: 'Proteína', val: results.macros.protein, color: 'bg-slate-900' },
                        { label: 'Gordura', val: results.macros.fat, color: 'bg-bento-primary' },
                        { label: 'Carbos', val: results.macros.carbs, color: 'bg-slate-400' }
                      ].map(m => (
                        <div key={m.label}>
                          <div className="flex justify-between text-xs font-bold mb-1">
                            <span className="text-bento-text-secondary">{m.label}</span>
                            <span className="text-bento-text-main">{m.val.grams.toFixed(0)}g ({m.val.percentage.toFixed(0)}%)</span>
                          </div>
                          <div className="h-2 bg-bento-bg rounded-full overflow-hidden">
                            <div className={`h-full ${m.color} transition-all duration-500`} style={{ width: `${m.val.percentage}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <AnimatePresence mode="wait">
                    {aiResponse ? (
                      <motion.section 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white rounded-3xl border border-bento-border p-8 shadow-sm prose prose-slate max-w-none prose-headings:text-bento-primary prose-headings:font-bold prose-strong:text-bento-primary"
                      >
                        <ReactMarkdown>{aiResponse}</ReactMarkdown>
                      </motion.section>
                    ) : (
                      <div className="bg-white/50 border-2 border-dashed border-bento-border rounded-3xl p-12 flex flex-col items-center justify-center text-center">
                        <ClipboardList className="w-12 h-12 text-slate-300 mb-4" />
                        <h3 className="font-bold text-bento-text-secondary">Aguardando Prescrição</h3>
                        <p className="text-xs text-bento-text-secondary/60">Configure os parâmetros e gere o plano alimentar.</p>
                      </div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Patient Modal */}
      <AnimatePresence>
        {selectedPatient && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSelectedPatient(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-bento-border flex justify-between items-center bg-slate-50">
                <h3 className="font-bold text-bento-text-main">{selectedPatient.id ? 'Editar Paciente' : 'Novo Paciente'}</h3>
                <button onClick={() => setSelectedPatient(null)} className="p-2 hover:bg-slate-200 rounded-lg"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-8 overflow-y-auto space-y-6 custom-scrollbar">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="md:col-span-2">
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Nome Completo</label>
                    <input type="text" value={selectedPatient.name} onChange={e => setSelectedPatient({...selectedPatient, name: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" placeholder="Ex: João da Silva" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Idade</label>
                    <input type="number" value={selectedPatient.age} onChange={e => setSelectedPatient({...selectedPatient, age: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Sexo</label>
                    <select value={selectedPatient.gender} onChange={e => setSelectedPatient({...selectedPatient, gender: e.target.value as any})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary">
                      <option value="male">Masculino</option>
                      <option value="female">Feminino</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Peso (kg)</label>
                    <input type="number" value={selectedPatient.weight} onChange={e => setSelectedPatient({...selectedPatient, weight: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Altura (cm)</label>
                    <input type="number" value={selectedPatient.height} onChange={e => setSelectedPatient({...selectedPatient, height: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Fator Atividade</label>
                    <select value={selectedPatient.activityFactor} onChange={e => setSelectedPatient({...selectedPatient, activityFactor: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary">
                      {ACTIVITY_FACTORS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Objetivo Padrão</label>
                    <select value={selectedPatient.goalType || 'loss'} onChange={e => setSelectedPatient({...selectedPatient, goalType: e.target.value as any})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary">
                      <option value="loss">Perda de Peso</option>
                      <option value="gain">Ganho de Peso</option>
                      <option value="maintenance">Manutenção</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Ajuste Padrão (kcal)</label>
                    <input type="number" value={selectedPatient.goalKcal || 500} onChange={e => setSelectedPatient({...selectedPatient, goalKcal: Number(e.target.value)})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Histórico Médico</label>
                    <textarea value={selectedPatient.medicalHistory} onChange={e => setSelectedPatient({...selectedPatient, medicalHistory: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary h-24 resize-none" placeholder="Doenças crônicas, medicações..." />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Alergias</label>
                    <input type="text" value={selectedPatient.allergies} onChange={e => setSelectedPatient({...selectedPatient, allergies: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" placeholder="Glúten, amendoim..." />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-bento-text-secondary uppercase block mb-1">Intolerâncias</label>
                    <input type="text" value={selectedPatient.intolerances} onChange={e => setSelectedPatient({...selectedPatient, intolerances: e.target.value})} className="w-full bg-bento-bg border border-bento-border rounded-xl px-4 py-3 text-sm outline-none focus:border-bento-primary" placeholder="Lactose, frutose..." />
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-bento-border flex gap-4 bg-slate-50">
                <button onClick={() => setSelectedPatient(null)} className="flex-grow py-3 border border-bento-border rounded-xl font-bold text-slate-500 hover:bg-slate-100 transition-all">Cancelar</button>
                <button onClick={() => savePatient(selectedPatient)} className="flex-grow py-3 bg-bento-primary text-white rounded-xl font-bold shadow-lg shadow-teal-100 hover:bg-teal-700 transition-all">Salvar Perfil</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}} />
    </div>
  );
}



