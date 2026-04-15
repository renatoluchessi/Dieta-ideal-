import { GoogleGenAI } from "@google/genai";
import { UserData, MetabolicResults } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateDietPlan(userData: UserData, results: MetabolicResults) {
  const prompt = `
    Você é um Assistente de Nutrição Clínica de alta precisão.
    Gere um plano alimentar e uma lista de substituições com base nos seguintes dados:

    DADOS DO PACIENTE:
    - Sexo: ${userData.gender === 'male' ? 'Masculino' : 'Feminino'}
    - Peso: ${userData.weight}kg
    - Altura: ${userData.height}cm
    - Idade: ${userData.age} anos
    - GET (Gasto Energético Total): ${results.tdee.toFixed(0)} kcal
    - VET (Valor Energético Total): ${results.tev.toFixed(0)} kcal
    
    CONTEXTO CLÍNICO:
    - Histórico Médico: ${userData.medicalHistory || 'Nenhum informado'}
    - Alergias: ${userData.allergies || 'Nenhuma informada'}
    - Intolerâncias: ${userData.intolerances || 'Nenhuma informada'}

    MACRONUTRIENTES:
    - Proteínas: ${results.macros.protein.grams.toFixed(1)}g (${results.macros.protein.percentage.toFixed(1)}%)
    - Gorduras: ${results.macros.fat.grams.toFixed(1)}g (${results.macros.fat.percentage.toFixed(1)}%)
    - Carboidratos: ${results.macros.carbs.grams.toFixed(1)}g (${results.macros.carbs.percentage.toFixed(1)}%)

    ESTRUTURA DA RESPOSTA (OBRIGATÓRIA - USE MARKDOWN):

    ## 2. PLANO ALIMENTAR ESTIMADO
    - Divida em refeições (Café da Manhã, Almoço, Lanche, Jantar).
    - Liste o alimento e a quantidade exata em gramas (g) ou mililitros (ml).
    - Indique os macros aproximados por refeição.

    ## 3. LISTA DE SUBSTITUIÇÃO EQUIVALENTE
    - Crie uma tabela de equivalência para os principais itens.
    - Garanta que as substituições respeitem o macronutriente predominante da fonte.
    - Ex: "100g de Arroz cozido = 100g de Batata Doce = 80g de Macarrão cozido".

    Mantenha a comunicação técnica, direta e profissional. Não inclua introduções ou conclusões genéricas.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  return response.text;
}
