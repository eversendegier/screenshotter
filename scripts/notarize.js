const { notarize } = require('@electron/notarize');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`Notariseren: ${appPath}`);
  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile: 'screenshotter-notary',
  });
  console.log('Notariseren klaar.');
};
