# Интерфейс модуля storage

Статус: заморожен в Волне 0.

## Публичный API

- `createNote({ title, body }) → Note`
- `findNotes(query) → Note[]`
- `deleteNote(id) → boolean`

## Данные

`Note = { id: string, title: string, body: string, createdAt: ISO-8601 }`.

## Владелец и пути

Модуль владеет `src/storage/**`.
