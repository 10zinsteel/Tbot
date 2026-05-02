const chatToggle = document.getElementById("chatToggle");
const chatWidget = document.getElementById("chatWidget");
const chatClose = document.getElementById("chatClose");
const newChatButton = document.getElementById("newChatButton");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendButton = document.getElementById("sendButton");
const MAX_INPUT_HEIGHT = 120;

function addMessage(text, sender) {
  const message = document.createElement("div");
  message.className = `message ${sender}`;
  message.textContent = text;
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function openChat() {
  chatWidget.classList.remove("hidden");
  chatToggle.classList.add("hidden");
  chatInput.focus();
  adjustInputHeight();
}

function closeChat() {
  chatWidget.classList.add("hidden");
  chatToggle.classList.remove("hidden");
}

chatToggle.addEventListener("click", openChat);
chatClose.addEventListener("click", closeChat);
newChatButton.addEventListener("click", async function () {
  newChatButton.disabled = true;
  sendButton.disabled = true;
  chatInput.disabled = true;

  try {
    const res = await fetch("/api/reset", { method: "POST" });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok || data.success !== true) {
      addMessage(data.error || "Could not start a new chat.", "bot");
      return;
    }

    chatMessages.innerHTML = "";
  } catch (err) {
    console.error(err);
    addMessage("Could not reset chat memory. Is the server running?", "bot");
  } finally {
    newChatButton.disabled = false;
    sendButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    adjustInputHeight();
  }
});

function adjustInputHeight() {
  chatInput.style.height = "auto";
  const nextHeight = Math.min(chatInput.scrollHeight, MAX_INPUT_HEIGHT);
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

chatInput.addEventListener("input", adjustInputHeight);

chatInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  const userText = chatInput.value.trim();
  if (!userText) {
    return;
  }

  addMessage(userText, "user");
  chatInput.value = "";
  adjustInputHeight();

  sendButton.disabled = true;
  newChatButton.disabled = true;
  chatInput.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userText }),
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      addMessage(data.error || "Something went wrong. Please try again.", "bot");
      return;
    }

    if (data.reply) {
      addMessage(data.reply, "bot");
    } else {
      addMessage("No reply from the assistant.", "bot");
    }
  } catch (err) {
    console.error(err);
    addMessage("Could not reach the server. Is it running?", "bot");
  } finally {
    sendButton.disabled = false;
    newChatButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

adjustInputHeight();
