# 🗳️ Sistema de Eleição de Oficiais

Sistema web completo para eleições, rodando em servidor local Node.js.

---

## ✅ Requisitos

- **Node.js** instalado (versão 14 ou superior)
- Download gratuito: https://nodejs.org

---

## 🚀 Como rodar

### Windows
1. Extraia a pasta `eleicao`
2. Abra o **Prompt de Comando** (cmd) dentro da pasta
3. Execute:
   ```
   node server.js
   ```
4. Acesse no navegador: **http://localhost:3000**

### Mac / Linux
1. Abra o **Terminal** na pasta `eleicao`
2. Execute:
   ```
   node server.js
   ```
3. Acesse: **http://localhost:3000**

---

## 🌐 Acesso pela rede (celulares e outros computadores)

Quando o servidor iniciar, ele exibirá o IP da sua rede, por exemplo:

```
╔══════════════════════════════════════════╗
║   🗳️  Sistema de Eleição de Oficiais      ║
╠══════════════════════════════════════════╣
║  Local:   http://localhost:3000            ║
║  Rede:    http://192.168.1.10:3000        ║
╚══════════════════════════════════════════╝
```

Todos os dispositivos na **mesma rede Wi-Fi** podem acessar pelo IP da Rede.
Gere um QR Code com esse endereço usando qualquer gerador online (ex: qr-code-generator.com)
para que os eleitores acessem facilmente pelo celular.

---

## 🔐 Acessos

| Perfil | Campo CPF | Senha |
|--------|-----------|-------|
| Admin  | `admin`   | `admin` |
| Eleitor | CPF cadastrado | qualquer senha |

---

## 📁 Estrutura

```
eleicao/
├── server.js          ← Servidor Node.js (sem dependências externas)
├── public/
│   └── index.html     ← Frontend completo (SPA)
├── data/
│   └── state.json     ← Dados salvos automaticamente
└── README.md
```

---

## 📋 Funcionalidades

- ✅ Cadastro de eleitores com validação de CPF único
- ✅ Importar eleitores via CSV (nome, email, cpf)
- ✅ Exportar lista de eleitores para CSV
- ✅ Lista de presença com check individual
- ✅ Check-in por QR Code + confirmação de CPF
- ✅ Check-in manual por CPF
- ✅ Cadastro de candidatos com foto/avatar
- ✅ Cadastro de cargos com número de vagas
- ✅ Votação anônima (sistema não registra quem votou em quem)
- ✅ Controle de duplicidade de voto
- ✅ Votos em branco automáticos
- ✅ Apuração automática com maioria absoluta
- ✅ Resultados bloqueados até encerramento
- ✅ Dados persistidos em arquivo JSON

---

## 📥 Formato do CSV de importação

```csv
nome,email,cpf
João Silva,joao@email.com,123.456.789-00
Maria Santos,maria@email.com,987.654.321-00
```

---

## 📷 Check-in por QR Code

1. Acesse o painel Admin → Presença → "Check-in QR"
2. Clique em "Iniciar câmera"
3. O eleitor aponta o celular com QR Code
4. O sistema lê e pede que o eleitor confirme o CPF
5. Presença registrada!

**Dica:** Gere QR Codes individuais com o CPF de cada eleitor usando:
https://www.qr-code-generator.com/

---

## 💾 Backup dos dados

Os dados ficam em `data/state.json`. Faça backup desse arquivo para preservar cadastros.
Para resetar tudo, delete o arquivo `state.json`.
