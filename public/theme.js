// Carbon theme zone on <html>: white, or g100 when the device prefers dark. Loaded in <head> to avoid a flash.
document.documentElement.classList.add(matchMedia("(prefers-color-scheme: dark)").matches ? "cds--g100" : "cds--white");
