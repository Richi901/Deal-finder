import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface SaleInfo {
  storeName: string;
  price: string;
  originalPrice?: string;
  discount?: string;
  url: string;
  description?: string;
}

export async function searchSales(itemName: string, location: string): Promise<SaleInfo[]> {
  const prompt = `Find the best current sales, promotions, and prices for "${itemName}" in or near "${location}". 
  Include the store name, current price, original price (if available), discount percentage or amount (if available), a direct URL to the product or store page, and a brief description of the deal.
  Focus on major retailers and local stores that have online presence or clear promotional data.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
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
    });

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
