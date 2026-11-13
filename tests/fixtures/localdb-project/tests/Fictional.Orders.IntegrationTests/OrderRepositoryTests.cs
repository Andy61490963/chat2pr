using System.Text.Json;
using Microsoft.Data.SqlClient;
using Xunit;

namespace Fictional.Orders.IntegrationTests;

// 虛構的整合測試：連線字串寫死 LocalDB，只能在 Windows 上直接執行。
public class OrderRepositoryTests
{
    private const string Inline = @"Data Source=(localdb)\MSSQLLocalDB;Initial Catalog=FictionalOrders;Integrated Security=True";

    private static string FromSettings()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "appsettings.json")));
        return doc.RootElement.GetProperty("ConnectionStrings").GetProperty("Orders").GetString()!;
    }

    [Fact]
    public void SavesAndReadsOrderFromSettingsConnection()
    {
        using var connection = new SqlConnection(FromSettings());
        connection.Open();
        using var create = connection.CreateCommand();
        create.CommandText = "IF OBJECT_ID('dbo.Orders') IS NULL CREATE TABLE dbo.Orders(Id int PRIMARY KEY, Customer nvarchar(50)); DELETE FROM dbo.Orders; INSERT INTO dbo.Orders VALUES(1, N'虛構客戶');";
        create.ExecuteNonQuery();
        using var read = connection.CreateCommand();
        read.CommandText = "SELECT Customer FROM dbo.Orders WHERE Id = 1";
        Assert.Equal("虛構客戶", (string)read.ExecuteScalar()!);
    }

    [Fact]
    public void ConnectsWithInlineConnection()
    {
        using var connection = new SqlConnection(Inline);
        connection.Open();
        Assert.Equal("FictionalOrders", connection.Database);
    }

    [Fact]
    public void PureUnitTest() => Assert.Equal(4, 2 + 2);
}
