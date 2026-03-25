import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface SaleInfo {
  storeName: string;
  price: string;
  originalPrice?: string;
  discount?: string;
  url: string;
  description?: string;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, initialDelay = 800): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      // Handle different error structures (SDK error vs raw response)
      const errorCode = error?.code || error?.error?.code || error?.status;
      const errorMessage = error?.message || error?.error?.message || "";
      const errorStatus = error?.status || error?.error?.status;

      const is503 = errorCode === 503 || 
                    errorCode === "503" ||
                    errorStatus === "UNAVAILABLE" ||
                    errorMessage.includes('503') ||
                    errorMessage.includes('high demand');
      
      if (is503 && i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function searchSales(itemName: string, location: string): Promise<SaleInfo[]> {
  const prompt = `Find up to 8 of the best current sales for "${itemName}" in or near "${location}". 
  Sort by "best deal" first. 
  For each deal, find the regular price and sale price. 
  Include store name, current price, original price, discount, URL, and a brief description.`;

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              storeName: { type: Type.STRING },
              price: { type: Type.STRING },
              originalPrice: { type: Type.STRING },
              discount: { type: Type.STRING },
              url: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ["storeName", "price", "url"],
          },
        },
      },
    }));

    const text = response.text;
    if (!text) return [];
    
    try {
      return JSON.parse(text.trim());
    } catch (e) {
      console.error("Failed to parse Gemini response as JSON:", text);
      return [];
    }
  } catch (error) {
    console.error("Error searching sales with Gemini:", error);
    return [];
  }
}
