export interface Env {
	AI: Ai;
}

/**
 * Transform SSE stream from Workers AI to plain text stream
 * Parses data: {"response": "text"} format and extracts just the text
 */
function createTextStreamTransformer(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(":")) continue;

				if (trimmed.startsWith("data: ")) {
					const data = trimmed.slice(6);
					if (data === "[DONE]") return;

					try {
						const json = JSON.parse(data);
						if (typeof json.response === "string" && json.response.length > 0) {
							controller.enqueue(encoder.encode(json.response));
						} else if (json.choices?.[0]?.delta?.content) {
							controller.enqueue(encoder.encode(json.choices[0].delta.content));
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		},
		flush(controller) {
			if (buffer.trim().startsWith("data: ")) {
				const data = buffer.trim().slice(6);
				if (data !== "[DONE]") {
					try {
						const json = JSON.parse(data);
						if (typeof json.response === "string" && json.response.length > 0) {
							controller.enqueue(encoder.encode(json.response));
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		},
	});
}

// CORS headers for cross-origin requests (needed for Lovable)
const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export default {
	async fetch(request, env): Promise<Response> {
		// Handle CORS preflight requests
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		const url = new URL(request.url);
		const baseUrl = url.origin;

		// Starter prompt for AI coding tools
		if (url.pathname === "/") {
			const starterPrompt = `I want to integrate the Sea Lion AI model into my app. Here's the API details:

API Base URL: ${baseUrl}

ENDPOINTS:

1. POST /chat - Non-streaming chat completion
   Request body:
   {
     "prompt": "Your question here",
     "system": "Optional system prompt"
   }
   OR
   {
     "messages": [
       {"role": "system", "content": "System prompt"},
       {"role": "user", "content": "User message"}
     ]
   }
   Response: { "response": "AI response text" }

2. POST /stream - Streaming chat completion (Server-Sent Events)
   Same request body as /chat
   Response: SSE stream with text chunks

EXAMPLE CODE (Non-streaming):

const response = await fetch('${baseUrl}/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Hello!',
    system: 'You are a helpful assistant'
  })
});
const data = await response.json();
console.log(data.response);

EXAMPLE CODE (Streaming):

const response = await fetch('${baseUrl}/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Tell me a story',
    system: 'You are a helpful assistant'
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let text = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  text += decoder.decode(value);
  console.log(text); // Plain text, no parsing needed!
}

Please help me build [describe your feature] using this Sea Lion AI API.`;

			return new Response(starterPrompt, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					...corsHeaders,
				},
			});
		}

		// Health check endpoint
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					status: "ok",
					model: "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
					endpoints: {
						chat: "/chat",
						stream: "/stream",
					},
				}),
				{
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				}
			);
		}

		// Only allow POST for chat endpoints
		if (request.method !== "POST") {
			return new Response(
				JSON.stringify({ error: "Method not allowed. Use POST." }),
				{
					status: 405,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				}
			);
		}

		// Parse request body
		let body: { messages?: Array<{ role: string; content: string }>; system?: string; prompt?: string };
		try {
			body = await request.json();
		} catch {
			return new Response(
				JSON.stringify({ error: "Invalid JSON body" }),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				}
			);
		}

		// Build messages array
		let messages: Array<{ role: string; content: string }> = [];

		if (body.messages && Array.isArray(body.messages)) {
			// Use provided messages array
			messages = body.messages;
		} else if (body.prompt) {
			// Simple prompt format
			if (body.system) {
				messages.push({ role: "system", content: body.system });
			}
			messages.push({ role: "user", content: body.prompt });
		} else {
			return new Response(
				JSON.stringify({
					error: "Request must include either 'messages' array or 'prompt' string",
					example: {
						messages: [
							{ role: "system", content: "You are a helpful assistant" },
							{ role: "user", content: "Hello!" },
						],
					},
					simpleExample: {
						prompt: "Hello!",
						system: "You are a helpful assistant",
					},
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				}
			);
		}

		// Non-streaming chat endpoint
		if (url.pathname === "/chat") {
			const response = await env.AI.run("@cf/aisingapore/gemma-sea-lion-v4-27b-it", {
				messages,
			});

			return new Response(JSON.stringify(response), {
				headers: {
					"Content-Type": "application/json",
					...corsHeaders,
				},
			});
		}

		// Streaming chat endpoint
		if (url.pathname === "/stream") {
			const stream = await env.AI.run("@cf/aisingapore/gemma-sea-lion-v4-27b-it", {
				messages,
				stream: true,
			});

			// Transform SSE to plain text stream
			const transformedStream = (stream as ReadableStream).pipeThrough(createTextStreamTransformer());

			return new Response(transformedStream, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					...corsHeaders,
				},
			});
		}

		// 404 for unknown endpoints
		return new Response(
			JSON.stringify({
				error: "Not found",
				availableEndpoints: ["/", "/health", "/chat", "/stream"],
			}),
			{
				status: 404,
				headers: {
					"Content-Type": "application/json",
					...corsHeaders,
				},
			}
		);
	},
} satisfies ExportedHandler<Env>;
