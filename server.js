const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT = 25000;

function validateTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return { valid: false, error: 'Topic is required and must be a string' };
  }
  
  const trimmed = topic.trim();
  
  if (trimmed.length < 3) {
    return { valid: false, error: 'Topic must be at least 3 characters long' };
  }
  
  if (trimmed.length > 100) {
    return { valid: false, error: 'Topic must be less than 100 characters' };
  }
  
  const validPattern = /^[a-zA-Z0-9\s\-,.'&()]+$/;
  if (!validPattern.test(trimmed)) {
    return { valid: false, error: 'Topic contains invalid characters' };
  }
  
  return { valid: true, topic: trimmed };
}

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue
  }
  
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (e) {
      // Continue
    }
  }
  
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      // Continue
    }
  }
  
  throw new Error('No valid JSON found in response');
}

function validateQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new Error('Questions must be an array');
  }
  
  if (questions.length !== 10) {
    throw new Error(`Expected 10 questions, got ${questions.length}`);
  }
  
  questions.forEach((q, index) => {
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question ${index + 1}: Missing or invalid 'question' field`);
    }
    
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Question ${index + 1}: Must have exactly 4 options`);
    }
    
    if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
      throw new Error(`Question ${index + 1}: 'correct' must be 0, 1, 2, or 3`);
    }
    
    if (!q.explanation || typeof q.explanation !== 'string') {
      throw new Error(`Question ${index + 1}: Missing or invalid 'explanation' field`);
    }
  });
  
  return true;
}

async function generateQuestions(topic) {
  if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY not configured in environment variables');
  }

  const systemPrompt = `You are an SSC exam question generator. Generate EXACTLY 10 multiple choice questions on the given topic.

CRITICAL RULES:
1. Return ONLY valid JSON, no markdown, no explanation outside JSON
2. Questions must be SSC CGL/CHSL/GD standard
3. Questions must be factual and exam-oriented
4. Each question must have exactly 4 options
5. Only 1 correct answer (index 0-3)
6. Include a brief explanation

JSON FORMAT (return array directly):
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Brief explanation here."
  }
]

Return ONLY the JSON array. No markdown. No code blocks. No extra text.`;

  const userPrompt = `Generate 10 SSC-level multiple choice questions on: ${topic}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    console.log(`[GROK] Calling API for topic: ${topic}`);
    
    const response = await fetch(OPENROUTER_API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': 'https://ssc-pyq-backend-claude-production.up.railway.app',
    'X-Title': 'SSC PYQ Quiz Generator'
  },
  body: JSON.stringify({
    model: 'meta-llama/llama-3.2-3b-instruct:free',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.4,
    max_tokens: 2000
  }),
  signal: controller.signal
});

    clearTimeout(timeoutId);

    console.log(`[GROK] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GROK] Error response: ${errorText}`);
      throw new Error(`Grok API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid response structure from Grok API');
    }

    const content = data.choices[0].message.content;
    console.log(`[GROK] Raw response length: ${content.length} chars`);

    const questions = extractJSON(content);
    validateQuestions(questions);
    
    console.log(`[GROK] Successfully generated ${questions.length} questions`);
    
    return questions;

  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - AI took too long to respond');
    }
    
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'SSC PYQ Quiz Generator',
    timestamp: new Date().toISOString()
  });
});

app.post('/generate', async (req, res) => {
  console.log('[REQUEST] Received generate request');
  
  try {
    const { topic } = req.body;
    
    const validation = validateTopic(topic);
    if (!validation.valid) {
      console.log(`[VALIDATION] Failed: ${validation.error}`);
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    const validatedTopic = validation.topic;
    console.log(`[VALIDATION] Topic approved: ${validatedTopic}`);

    const questions = await generateQuestions(validatedTopic);

    res.json({
      success: true,
      topic: validatedTopic,
      total: questions.length,
      questions: questions
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate questions'
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.use((err, req, res, next) => {
  console.error('[FATAL ERROR]', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ GROK_API_KEY configured: ${GROK_API_KEY ? 'Yes' : 'No'}`);
});
