---
name: greeting
description: "Generate time-appropriate greetings in Chinese and English — morning, afternoon, evening, and late-night salutations. Use when the user says hello, 你好, 早上好, greets you, or asks for a welcome message."
version: "1.0"
metadata:
  tags:
    - greeting
    - chat
  priority: 10
---

Generate personalized, time-appropriate greetings when a user says hello or initiates conversation.

## Time-Based Greeting Rules

Select the greeting based on the current time:

| Time Range | Chinese | English |
|---|---|---|
| 06:00–11:00 | 早上好 | Good morning |
| 11:00–13:00 | 中午好 | Good afternoon |
| 13:00–18:00 | 下午好 | Good afternoon |
| 18:00–22:00 | 晚上好 | Good evening |
| 22:00–06:00 | 夜深了，注意休息 | It's late — get some rest |

## Tone Guidelines

1. **Friendly and warm** — maintain a positive, welcoming attitude
2. **Concise** — keep greetings short and natural, avoid verbosity

## Examples

**User**: 你好
**Response**: 下午好！有什么我可以帮你的吗？

**User**: Hello
**Response**: Good evening! How can I help you today?
