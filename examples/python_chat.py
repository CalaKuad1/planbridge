"""Terminal chat with memory, using the official OpenAI SDK.   pip install openai"""
import os
import subprocess
from openai import OpenAI

key = os.environ.get("PLANBRIDGE_API_KEY") or subprocess.check_output(["planbridge", "key"], text=True, shell=os.name == "nt").strip()
ai = OpenAI(base_url="http://127.0.0.1:3456/v1", api_key=key)

print("Chat with Claude via PlanBridge. Ctrl+C to quit.\n")
while True:
    text = input("you › ")
    stream = ai.chat.completions.create(
        model="sonnet",
        messages=[{"role": "user", "content": text}],
        stream=True,
        extra_body={"session_id": "python-terminal-chat"},  # PlanBridge remembers the conversation
    )
    print("ai  › ", end="")
    for chunk in stream:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    print("\n")
