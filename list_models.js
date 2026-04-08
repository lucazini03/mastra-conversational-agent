// list-models.js
import 'dotenv/config';

const apiKey = process.env.GOOGLE_API_KEY;

async function checkModels() {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1alpha/models?key=${apiKey}`);
    const data = await response.json();

    if (!data.models) {
      console.error("Failed to fetch models:", data);
      return;
    }

    // Filter only models that support bidirectional streaming
    const bidiModels = data.models
      .filter(m => m.supportedGenerationMethods?.includes('bidiGenerateContent'))
      .map(m => m.name);

    console.log("🟢 Models supporting bidiGenerateContent:");
    console.log(bidiModels);

  } catch (error) {
    console.error("Error fetching models:", error);
  }
}

checkModels();