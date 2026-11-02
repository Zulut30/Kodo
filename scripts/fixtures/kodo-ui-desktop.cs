using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

// Owned live-acceptance fixture. It neither activates the user's window nor
// reads the clipboard. The coordinator compiles this into a private temp folder.
class KodoForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; }
    }
    [STAThread] static void Main(string[] args) {
        if (args.Length != 1) return;
        Application.EnableVisualStyles();
        using (var form = new KodoForm()) {
            form.Text = "Kodo owned acceptance fixture";
            form.Size = new Size(440, 260); form.ShowInTaskbar = false;
            var name = new TextBox { AccessibleName = "Name", Location = new Point(20, 40), Width = 350 };
            var verify = new Button { AccessibleName = "Verify", Text = "Verify", Location = new Point(20, 85) };
            var result = new TextBox { AccessibleName = "Verification result", Text = "Not verified", ReadOnly = true, Location = new Point(20, 130), Width = 350 };
            verify.Click += delegate { result.Text = "Verified " + name.Text; };
            form.Controls.AddRange(new Control[] { name, verify, result });
            form.Shown += delegate { File.WriteAllText(args[0], "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"windowId\":\"w-" + form.Handle.ToInt64() + "\"}"); };
            using (var timer = new Timer { Interval = 600000 }) {
                timer.Tick += delegate { form.Close(); }; timer.Start();
                Application.Run(form);
            }
        }
    }
}
