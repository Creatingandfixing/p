(function () {

  if (window.myChatWidgetLoaded) return;
  window.myChatWidgetLoaded = true;

  const script = document.createElement("div");

  script.innerHTML = `
    <style>
      #chat-button {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: #0a7cff;
        color: white;
        font-size: 24px;
        border: none;
        cursor: pointer;
        z-index: 999999;
      }

      #chat-widget {
        display: none;
        position: fixed;
        bottom: 90px;
        right: 20px;
        width: 320px;
        height: 450px;
        background: white;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        overflow: hidden;
        flex-direction: column;
        font-family: Arial;
        z-index: 999999;
      }

      #chat-box {
        flex: 1;
        padding: 10px;
        overflow-y: auto;
        background: #f5f7fa;
      }

      .msg {
        padding: 8px 12px;
        border-radius: 12px;
        margin: 5px 0;
        max-width: 75%;
      }

      .user {
        background: #0a7cff;
        color: white;
        margin-left: auto;
      }

      .bot {
        background: #e4e6eb;
      }
    </style>

    <button id="chat-button">💬</button>

    <div id="chat-widget">
      <div style="background:#0a7cff;color:white;padding:10px;">
        Support
      </div>

      <div id="chat-box"></div>

      <div style="display:flex;">
        <input id="chat-input" style="flex:1;padding:10px;border:none;" placeholder="Skriv..." />
        <button id="send-btn">➤</button>
      </div>
    </div>
  `;

  document.body.appendChild(script);

  const btn = document.getElementById("chat-button");
  const widget = document.getElementById("chat-widget");
  const input = document.getElementById("chat-input");
  const box = document.getElementById("chat-box");

  const userId = localStorage.getItem("chatUser") || crypto.randomUUID();
  localStorage.setItem("chatUser", userId);

  function addMessage(text, sender) {
    const div = document.createElement("div");
    div.className = "msg " + sender;
    div.innerText = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  btn.onclick = () => {
    widget.style.display =
      widget.style.display === "none" ? "flex" : "none";
  };

  async function sendMessage() {
    const msg = input.value.trim();
    if (!msg) return;

    addMessage(msg, "user");
    input.value = "";

    const res = await fetch("https://ai-rormokare.onrender.com/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: msg,
        userId
      })
    });

    const data = await res.json();

    data.replies.forEach(r => addMessage(r, "bot"));
  }

  document.getElementById("send-btn").onclick = sendMessage;
  input.addEventListener("keypress", e => {
    if (e.key === "Enter") sendMessage();
  });

})();