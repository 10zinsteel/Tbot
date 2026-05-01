const chatToggle = document.getElementById("chatToggle");
const chatWidget = document.getElementById("chatWidget");
const chatClose = document.getElementById("chatClose");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

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
}

function closeChat() {
  chatWidget.classList.add("hidden");
  chatToggle.classList.remove("hidden");
}

chatToggle.addEventListener("click", openChat);
chatClose.addEventListener("click", closeChat);

chatForm.addEventListener("submit", function (event) {
  event.preventDefault();

  const userText = chatInput.value.trim();
  if (!userText) {
    return;
  }

  addMessage(userText, "user");
  chatInput.value = "";
  chatInput.focus();

  setTimeout(function () {
    addMessage("Got it — SMS sending will be added later.", "bot");
  }, 500);
});
