const chatToggle = document.getElementById("chatToggle");
const chatWidget = document.getElementById("chatWidget");
const chatClose = document.getElementById("chatClose");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
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

chatForm.addEventListener("submit", function (event) {
  event.preventDefault();

  const userText = chatInput.value.trim();
  if (!userText) {
    return;
  }

  addMessage(userText, "user");
  chatInput.value = "";
  adjustInputHeight();
  chatInput.focus();

  setTimeout(function () {
    addMessage("Got it — SMS sending will be added later.", "bot");
  }, 500);
});

adjustInputHeight();
