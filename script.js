const sidebarItems = document.querySelectorAll(".sidebar-item");
const views = document.querySelectorAll(".view");

sidebarItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();

    const view = item.dataset.view;

    sidebarItems.forEach((i) => i.classList.toggle("active", i === item));
    views.forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  });
});
