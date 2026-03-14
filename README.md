# 🎫 Discord Ticket Transcript

Página web que renderiza transcrições de tickets do Discord com visual idêntico ao Discord (dark mode).

## 🚀 Como usar

### 1. Deploy na Vercel

1. Faça fork ou clone este repositório no GitHub
2. Acesse [vercel.com](https://vercel.com) e importe o repositório
3. Clique em **Deploy** — sem configuração adicional necessária
4. Copie a URL gerada (ex: `meu-transcript.vercel.app`)

### 2. Configure o bot

Abra o arquivo `performance_ticket.py` e altere a linha:

```python
TRANSCRIPT_BASE_URL = 'https://seu-projeto.vercel.app'
```

Substitua pela URL do seu projeto na Vercel.

### 3. Pronto!

Ao fechar um ticket, o bot irá:
- Gerar o transcript automaticamente
- Enviar o link no **canal de logs** com botão "📄 Ver Transcript"
- Enviar o link via **DM** para quem fechou o ticket

## 📁 Estrutura

```
/
├── index.html     # Página do transcript (dark mode igual Discord)
├── vercel.json    # Configuração do Vercel
└── README.md      # Este arquivo
```

## ✨ O que aparece no transcript

- Mensagens com avatar, nome, timestamp
- Embeds coloridos (igual Discord)
- Botões desabilitados
- Imagens anexadas
- Tag APP nos bots
- Barra de info: quem abriu, categoria, motivo de fechamento
- Dark mode 100% fiel ao Discord
