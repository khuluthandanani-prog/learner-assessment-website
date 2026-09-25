const $ = (s, r = document) => r.querySelector(s);

const $$ = (s, r = document) =>
  [...r.querySelectorAll(s)];

const API =
  "https://rise-collective-assessments-api.onrender.com";


/* =========================
   SESSION
   ========================= */

function me() {

  try {

    return JSON.parse(
      localStorage.getItem("rise_session")
    );

  } catch (error) {

    return null;

  }

}


/* =========================
   LOGOUT
   ========================= */

function logout() {

  localStorage.removeItem(
    "rise_session"
  );

  window.location.href =
    "index.html";

}


/* =========================
   CHECK LOGIN
   ========================= */

function guard(role) {

  const user = me();

  if (!user) {

    window.location.href =
      "index.html";

    return null;

  }


  if (
    role &&
    user.role !== role
  ) {

    window.location.href =
      "index.html";

    return null;

  }


  const who =
    document.getElementById("who");

  if (who) {

    who.textContent =
      user.name;

  }


  return user;

}


/* =========================
   FILE READER
   ========================= */

const readFile = file =>
  new Promise((resolve, reject) => {

    if (!file) {

      resolve(null);
      return;

    }

    if (file.size > 1500000) {

      reject(
        "File too large. Maximum size is 1.5MB."
      );

      return;

    }

    const reader =
      new FileReader();

    reader.onload = () => {

      resolve({
        name: file.name,
        data: reader.result
      });

    };

    reader.onerror = reject;

    reader.readAsDataURL(file);

  });


/* =========================
   FILE DOWNLOAD
   ========================= */

const fileLink = file => {

  if (!file) return "";

  return `
    <a
      class="btn sm"
      href="${file.data}"
      download="${file.name}"
    >
      ⬇ ${file.name}
    </a>
  `;

};
